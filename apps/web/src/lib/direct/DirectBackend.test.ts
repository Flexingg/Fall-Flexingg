import { FakeSparky } from '@gauntlet/sparky/testing';
import { describe, expect, it } from 'vitest';
import { DirectBackend, DirectError, type KeyValue } from './DirectBackend';

const NOW = new Date('2026-10-02T18:00:00Z'); // Fri 2 Oct, Chicago
const TZ = 'America/Chicago';

function memory(): KeyValue & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void (v == null ? map.delete(k) : map.set(k, v)),
  };
}

function setup(opts: { fetch?: typeof fetch } = {}) {
  const fake = new FakeSparky();
  const user = fake.addUser({
    id: 'u1',
    email: 'alex.morgan@example.com',
    password: 'x',
    name: 'Alex Morgan',
  });
  // Garmin steps, a phone check-in for another day, phone-synced distance, and two workouts.
  user.daily.push(
    {
      entry_date: '2026-10-02',
      source_provider: 'garmin',
      total_steps: 9412,
      active_calories: 612,
    },
    { entry_date: '2026-10-01', source_provider: 'garmin', total_steps: 11000 },
  );
  user.checkIns.push({
    entry_date: '2026-09-30',
    steps: 12000,
    updated_at: '2026-09-30T20:00:00Z',
  });
  user.categories.push({ id: 'cat-d', name: 'distance', frequency: 'Daily', data_type: 'numeric' });
  user.custom['cat-d'] = [{ date: '2026-10-01', value: '8500', timestamp: '2026-10-01T23:00:00Z' }];
  user.exerciseEntries.push(
    {
      entry_date: '2026-10-02',
      exercise_name: 'Running',
      duration_minutes: 40,
      calories_burned: 450,
    },
    { entry_date: '2026-10-02', exercise_name: 'Yoga', duration_minutes: 30, calories_burned: 100 },
  );
  const kv = memory();
  const key = fake.mintKey('u1');
  const backend = new DirectBackend({
    sparkyUrl: fake.baseUrl,
    apiKey: key,
    kv,
    timezone: TZ,
    fetch: opts.fetch ?? fake.fetch,
    now: () => NOW,
  });
  return { fake, user, kv, key, backend };
}

describe('DirectBackend', () => {
  it('nudges a new account with no data and nothing linked', async () => {
    const { backend, user } = setup();
    user.daily.length = 0;
    user.checkIns.length = 0;
    user.exerciseEntries.length = 0;
    user.custom['cat-d'] = [];
    expect((await backend.today()).hasSources).toBe(false);
  });

  it('shows today and trends merged from every SparkyFitness source', async () => {
    const { backend } = setup();
    const today = await backend.today();
    expect(today.date).toBe('2026-10-02');
    expect(today.metrics.map((m) => [m.key, m.value])).toEqual([
      ['steps', 9412],
      ['active_calories', 612],
      ['active_minutes', 70],
      ['distance', null],
    ]);
    expect(today.featured).toBeNull();
    expect(today.hasSources).toBe(true);

    const week = await backend.trends('week', 'steps');
    // Mon 28 Sep .. Sun 4 Oct: Wed none, Wed-Thu steps from check-in / garmin
    expect(week.total).toBe(12000 + 11000 + 9412);
    expect(week.bars.map((b) => b.label).join('')).toBe('MTWTFSS');
    expect(week.rankHistory).toBeNull();
    expect(week.personalBests.map((p) => p.label)).toEqual([
      'Best distance day',
      'Best step day',
      '10k-step streak',
      'Workouts, 30 days',
    ]);
    expect(week.personalBests[0]!.value).toBe('8.5 km');
  });

  it("feeds the live wallpaper today's food, water and lifting against goals", async () => {
    const { backend, user } = setup();
    user.goals.push({ from: '2026-01-01', goals: { calories: 2400, protein: 160 } });
    user.nutrition.push({ date: '2026-10-02', calories: 1200, protein: 80 });
    user.exerciseEntries.push(
      { entry_date: '2026-10-02', exercise_name: 'Squat', sets: [{ reps: 5, weight: 100 }] },
      { entry_date: '2026-09-25', exercise_name: 'Squat', sets: [{ reps: 10, weight: 100 }] },
    );
    const w = await backend.wallpaper();
    expect(w).toMatchObject({
      date: '2026-10-02',
      timezone: TZ,
      calories: { value: 1200, goal: 2400 },
      protein: { value: 80, goal: 160 },
      volume: { value: 500, goal: 1000 },
      volumeGoalSource: 'best_weekday',
    });
  });

  it('reads the profile from SparkyFitness and keeps settings on the phone', async () => {
    const { backend } = setup();
    const me = await backend.me();
    expect(me).toMatchObject({
      displayName: 'Alex Morgan',
      initials: 'AM',
      email: 'alex.morgan@example.com',
      timezone: TZ,
    });
    expect(me.settings).toEqual({
      shareWorkoutDetails: true,
      shareEvents: true,
      healthConnectSync: false,
      shareProfileStats: false,
      units: null,
      clock: null,
      locale: null,
    });
    const updated = await backend.updateSettings({ healthConnectSync: true });
    expect(updated.settings.healthConnectSync).toBe(true);
    expect((await backend.me()).settings.healthConnectSync).toBe(true);
    const imperial = await backend.updateSettings({ units: 'imperial' });
    expect(imperial.settings.units).toBe('imperial');
  });

  it('caches on the phone and only refetches when asked or stale', async () => {
    const { backend, fake } = setup();
    await backend.today();
    const calls = fake.calls.length;
    await backend.today();
    await backend.trends('month', 'distance');
    expect(fake.calls.length).toBe(calls);
    await backend.sync();
    expect(fake.calls.length).toBeGreaterThan(calls);
  });

  it('works offline from the cache, but says so when there is nothing cached', async () => {
    let offline = false;
    const fake = setup();
    const flaky: typeof fetch = (...args) =>
      offline ? Promise.reject(new TypeError('network')) : fake.fake.fetch(...args);
    const kv = fake.kv;
    const backend = new DirectBackend({
      sparkyUrl: fake.fake.baseUrl,
      apiKey: fake.key,
      kv,
      timezone: TZ,
      fetch: flaky,
      now: () => NOW,
    });
    await backend.today(); // warm the caches
    await backend.me();
    offline = true;
    await backend.sync().catch(() => undefined);
    expect((await backend.today()).metrics[0]!.value).toBe(9412);
    expect((await backend.me()).displayName).toBe('Alex Morgan');

    const cold = new DirectBackend({
      sparkyUrl: fake.fake.baseUrl,
      apiKey: fake.key,
      kv: memory(),
      timezone: TZ,
      fetch: flaky,
      now: () => NOW,
    });
    await expect(cold.today()).rejects.toMatchObject({ code: 'sparky_unreachable' });
  });

  it('reports a rejected key even when data is cached', async () => {
    const { backend, fake } = setup();
    await backend.today();
    fake.revokeAllKeys('u1');
    await expect(backend.sync()).rejects.toMatchObject({
      name: 'DirectError',
      code: 'sparky_key_invalid',
    });
    await expect(backend.check()).rejects.toBeInstanceOf(DirectError);
    await expect(backend.me()).rejects.toMatchObject({ code: 'sparky_key_invalid' });
  });

  it('lists sources with provider spellings merged', async () => {
    const { backend } = setup();
    const s = await backend.sources();
    expect(s.sparkyUrl).toBe('https://sparky.test');
    expect(s.integrationsUrl).toBe('https://sparky.test/settings?section=integrations');
    expect(s.providers).toEqual([{ source: 'garmin', label: 'Garmin Connect', records: 120 }]);
  });

  it('sends Health Connect records straight to SparkyFitness and refreshes afterwards', async () => {
    const { backend, user, kv } = setup();
    await backend.today();
    await backend.ingest([{ type: 'step', value: 15000, date: '2026-10-02', unit: 'count' }]);
    expect(user.ingested[0]).toMatchObject({
      type: 'step',
      value: 15000,
      source: 'Health Connect',
    });
    expect(kv.map.has('gauntlet.direct.rows')).toBe(false);
    // The fake stores steps as a check-in; Garmin's 9,412 still wins nothing: highest single source.
    expect((await backend.today()).metrics[0]!.value).toBe(15000);
  });

  it('connects Garmin from the phone through SparkyFitness, with a code when Garmin asks', async () => {
    const { backend, user, fake } = setup();
    fake.garminAccounts.set('g@example.com', { password: 'pw', mfaCode: '123456' });
    expect((await backend.garminStatus()).linked).toBe(false);

    const step1 = await backend.garminLogin('g@example.com', 'pw');
    if (step1.status !== 'needs_mfa') throw new Error('expected an MFA step');
    await expect(backend.garminMfa(step1.clientState, '999999')).rejects.toMatchObject({
      code: 'garmin_mfa',
    });

    const again = await backend.garminLogin('g@example.com', 'pw');
    if (again.status !== 'needs_mfa') throw new Error('expected an MFA step');
    expect(await backend.garminMfa(again.clientState, '123456')).toEqual({ status: 'connected' });
    expect((await backend.garminStatus()).linked).toBe(true);
    await expect.poll(() => user.garmin?.syncs ?? 0).toBeGreaterThan(0);

    expect(await backend.garminSync()).toEqual({ ok: true });
    expect(await backend.garminDisconnect()).toEqual({ ok: true });
    expect((await backend.garminStatus()).linked).toBe(false);
  });

  it('says what went wrong with Garmin in plain words', async () => {
    const { backend, fake } = setup();
    fake.garminAccounts.set('g@example.com', { password: 'pw' });
    await expect(backend.garminLogin('g@example.com', 'wrong')).rejects.toMatchObject({
      code: 'garmin_credentials',
      message: "Garmin didn't accept that email and password.",
    });
    fake.garminDown = true;
    await expect(backend.garminLogin('g@example.com', 'pw')).rejects.toMatchObject({
      code: 'garmin_unreachable',
    });
    await expect(backend.garminSync()).rejects.toBeInstanceOf(DirectError);
  });

  it('links apps from the phone with a key or a switch; sign-in apps point to SparkyFitness', async () => {
    const { backend, user } = setup();
    const all = await backend.connections();
    expect(all).toHaveLength(9);
    expect(all.find((c) => c.id === 'strava')).toMatchObject({
      state: 'unavailable',
      settingsUrl: 'https://sparky.test/settings?section=integrations',
    });
    await expect(backend.connect('strava')).rejects.toMatchObject({ code: 'oauth_unavailable' });
    await expect(backend.connect('hevy', { apiKey: 'wrong-key-123' })).rejects.toMatchObject({
      code: 'provider_key',
    });

    expect(await backend.connect('hevy', { apiKey: 'good-hevy-key' })).toEqual({
      status: 'connected',
    });
    await expect
      .poll(() => user.providers.find((p) => p.provider_type === 'hevy')?.syncs ?? 0)
      .toBeGreaterThan(0);
    expect((await backend.connections()).find((c) => c.id === 'hevy')!.state).toBe('connected');

    expect(await backend.syncApp('hevy')).toEqual({ ok: true });
    await backend.disconnect('hevy');
    expect((await backend.connections()).find((c) => c.id === 'hevy')!.state).toBe('disconnected');
    await expect(backend.syncApp('hevy')).rejects.toMatchObject({ code: 'not_connected' });
  });
});
