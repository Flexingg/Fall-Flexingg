import { describe, expect, it } from 'vitest';
import {
  completeOAuth,
  connectProvider,
  disconnectProvider,
  listConnections,
  syncProvider,
  SparkyClient,
  type ConnectionsEnv,
} from '../src/index.js';
import { FakeSparky } from '../src/fakeSparky.js';

function setup(over: Partial<ConnectionsEnv> = {}) {
  const fake = new FakeSparky();
  const user = fake.addUser({ id: 'u1', email: 'a@x.test', password: 'p', name: 'A' });
  const key = fake.mintKey('u1');
  const client = new SparkyClient({ baseUrl: fake.baseUrl, fetch: fake.fetch });
  const env: ConnectionsEnv = {
    sparkyUrl: 'https://sparky.test',
    oauthAvailable: true,
    oauth: {
      strava: { clientId: 'sid', clientSecret: 'ssec' },
      fitbit: { clientId: 'fid', clientSecret: 'fsec' },
      oura: { clientId: 'oid', clientSecret: 'osec' },
      polar: { clientId: 'pid', clientSecret: 'psec' },
    },
    now: () => new Date('2026-10-02T12:00:00Z'),
    ...over,
  };
  const states = async () =>
    Object.fromEntries((await listConnections(client, key, env)).map((c) => [c.id, c]));
  return { fake, user, key, client, env, states };
}

describe('connections', () => {
  it('lists all nine, with kinds, and nothing connected to begin with', async () => {
    const { states } = setup();
    const all = await states();
    expect(Object.keys(all)).toEqual([
      'garmin',
      'strava',
      'fitbit',
      'oura',
      'polar',
      'coros',
      'hevy',
      'liftosaur',
      'wger',
    ]);
    expect(Object.values(all).every((c) => c.state === 'disconnected')).toBe(true);
    expect(all.garmin!.kind).toBe('login');
    expect(all.strava!.kind).toBe('oauth');
    expect(all.hevy!.kind).toBe('api_key');
    expect(all.wger!.kind).toBe('library');
  });

  it('only offers OAuth providers the server has app keys for (COROS needs none)', async () => {
    const { states } = setup({ oauth: { strava: { clientId: 'sid', clientSecret: 's' } } });
    const all = await states();
    expect(all.strava!.state).toBe('disconnected');
    expect(all.coros!.state).toBe('disconnected');
    expect(all.fitbit!.state).toBe('unavailable');
    expect(all.fitbit!.note).toMatch(/server owner/);
  });

  it('points OAuth providers at SparkyFitness when there is no Gauntlet server', async () => {
    const { states, client, key, env } = setup({ oauthAvailable: false });
    const all = await states();
    expect(all.oura!.state).toBe('unavailable');
    expect(all.oura!.settingsUrl).toBe('https://sparky.test/settings?section=integrations');
    expect(all.hevy!.state).toBe('disconnected'); // keys still work from the phone
    await expect(connectProvider(client, key, 'oura', env)).rejects.toMatchObject({
      code: 'oauth_unavailable',
    });
  });

  it('connects an OAuth provider: record with the server keys, sign-in address, then the code', async () => {
    const { states, client, key, env, user } = setup();
    const res = await connectProvider(client, key, 'strava', env);
    expect(res).toMatchObject({ status: 'redirect' });
    expect((res as { url: string }).url).toContain('auth.strava.test');
    expect(user.providers[0]).toMatchObject({
      provider_type: 'strava',
      app_id: 'sid',
      app_key: 'ssec',
      sync_frequency: 'hourly', // SparkyFitness only syncs by itself when it isn't "manual"
    });
    expect((await states()).strava!.state).toBe('disconnected'); // not until the code comes back

    await completeOAuth(client, key, 'strava', { code: 'good-code' });
    expect((await states()).strava!.state).toBe('connected');

    await disconnectProvider(client, key, 'strava');
    expect((await states()).strava!.state).toBe('disconnected');
    expect(user.providers).toHaveLength(1); // kept, so connecting again is one tap
  });

  it('connects COROS without any app keys, and passes the state Polar and COROS need', async () => {
    const { client, key, env, states } = setup();
    const res = await connectProvider(client, key, 'coros', env);
    expect(res.status).toBe('redirect');
    await expect(completeOAuth(client, key, 'coros', { code: 'good-code' })).rejects.toMatchObject({
      code: 'provider_state',
    });
    await completeOAuth(client, key, 'coros', { code: 'good-code', state: 'abc' });
    expect((await states()).coros!.state).toBe('connected');
  });

  it('explains a bad or expired sign-in code', async () => {
    const { client, key, env } = setup();
    await connectProvider(client, key, 'fitbit', env);
    await expect(completeOAuth(client, key, 'fitbit', { code: 'nope' })).rejects.toMatchObject({
      code: 'provider_state',
      message: 'That sign-in link has expired. Start again.',
    });
  });

  it('connects Hevy and Liftosaur with an API key and rejects a wrong one without keeping it', async () => {
    const { client, key, env, states, user } = setup();
    await expect(
      connectProvider(client, key, 'hevy', env, { apiKey: 'wrong-key-1' }),
    ).rejects.toMatchObject({
      code: 'provider_key',
      message: "Hevy didn't accept that API key. Check it and try again.",
    });
    expect(user.providers).toHaveLength(0);

    expect(await connectProvider(client, key, 'hevy', env, { apiKey: 'good-hevy-key' })).toEqual({
      status: 'connected',
    });
    expect(
      await connectProvider(client, key, 'liftosaur', env, { apiKey: 'good-liftosaur-key' }),
    ).toEqual({
      status: 'connected',
    });
    const all = await states();
    expect(all.hevy!.state).toBe('connected');
    expect(all.liftosaur!.state).toBe('connected');
    expect(user.providers.find((p) => p.provider_type === 'hevy')!.sync_frequency).toBe('hourly');

    await disconnectProvider(client, key, 'hevy');
    expect((await states()).hevy!.state).toBe('disconnected');
    expect(user.providers.some((p) => p.provider_type === 'hevy')).toBe(false); // the key goes too
  });

  it('switches wger on and off', async () => {
    const { client, key, env, states } = setup();
    await connectProvider(client, key, 'wger', env);
    expect((await states()).wger!.state).toBe('connected');
    await disconnectProvider(client, key, 'wger');
    expect((await states()).wger!.state).toBe('disconnected');
  });

  it('syncs a connected provider and brings its data into SparkyFitness', async () => {
    const { client, key, env, user } = setup();
    await connectProvider(client, key, 'strava', env);
    await expect(syncProvider(client, key, 'strava', 7, env.now!())).rejects.toMatchObject({
      code: 'provider_reauth', // not signed in yet
    });
    await completeOAuth(client, key, 'strava', { code: 'good-code' });
    await syncProvider(client, key, 'strava', 7, env.now!());
    expect(user.daily.some((r) => r.source_provider === 'strava')).toBe(true);
  });

  it('keeps a person from connecting an app with the wrong flow', async () => {
    const { client, key, env } = setup();
    await expect(connectProvider(client, key, 'garmin', env)).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(completeOAuth(client, key, 'hevy', { code: 'x' })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(connectProvider(client, key, 'hevy', env)).rejects.toMatchObject({
      code: 'bad_request',
    });
  });
});
