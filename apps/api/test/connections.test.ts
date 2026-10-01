import type { ConnectionsResponse, ConnectResult, TodayResponse } from '@gauntlet/shared';
import { SparkyClient } from '@gauntlet/sparky';
import { FakeSparky } from '@gauntlet/sparky/testing';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, runMigrations } from '../src/db/index.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/gauntlet_test';
const fake = new FakeSparky();
let app: FastifyInstance;
let closeDb: () => Promise<void>;
let access = '';

beforeAll(async () => {
  const { db, client } = createDb(DB_URL);
  await db.execute(
    sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`,
  );
  await runMigrations(db);
  const cfg = loadConfig({
    DATABASE_URL: DB_URL,
    SPARKY_URL: fake.baseUrl,
    PUBLIC_WEB_URL: 'https://gauntlet.test',
    JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    SYNC_INTERVAL_MINUTES: '0',
    // Only Strava and Fitbit have app keys on this server.
    OAUTH_STRAVA_CLIENT_ID: 'sid',
    OAUTH_STRAVA_CLIENT_SECRET: 'ssec',
    OAUTH_FITBIT_CLIENT_ID: 'fid',
    OAUTH_FITBIT_CLIENT_SECRET: 'fsec',
    OAUTH_OURA_CLIENT_ID: 'half-configured', // no secret: counts as not set up
  });
  ({ app } = await buildApp({
    db,
    cfg,
    sparky: new SparkyClient({ baseUrl: fake.baseUrl, fetch: fake.fetch }),
    now: () => new Date(),
  }));
  closeDb = () => client.end();
  fake.addUser({ id: 'u-bo', email: 'bo@example.com', password: 'pw-bo', name: 'Bo' });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { method: 'password', email: 'bo@example.com', password: 'pw-bo' },
    headers: { 'x-gauntlet-client': 'native' },
  });
  access = (res.json() as { accessToken: string }).accessToken;
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { authorization: `Bearer ${access}` } });
const list = async () =>
  Object.fromEntries(
    ((await call('GET', '/api/connections')).json() as ConnectionsResponse).connections.map((c) => [
      c.id,
      c,
    ]),
  );

describe('linking apps through the Gauntlet API', () => {
  it('flags a brand-new account with nothing connected', async () => {
    const today = (await call('GET', '/api/me/today')).json() as TodayResponse;
    expect(today.hasSources).toBe(false);
  });

  it('lists all nine, marking those the server has no app keys for', async () => {
    const all = await list();
    expect(Object.keys(all)).toHaveLength(9);
    expect(all.strava!.state).toBe('disconnected');
    expect(all.fitbit!.state).toBe('disconnected');
    expect(all.oura!.state).toBe('unavailable');
    expect(all.polar!.state).toBe('unavailable');
    expect(all.coros!.state).toBe('disconnected');
  });

  it('connects Strava: sign-in address, then the code, then data arrives and standings refresh', async () => {
    const start = await call('POST', '/api/connections/strava/connect');
    expect(start.statusCode).toBe(200);
    const body = start.json() as Extract<ConnectResult, { status: 'redirect' }>;
    expect(body.status).toBe('redirect');
    expect(body.url).toContain('client_id=sid');

    const bad = await call('POST', '/api/connections/strava/oauth', { code: 'nope' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'provider_state' });

    const done = await call('POST', '/api/connections/strava/oauth', {
      code: 'good-code',
      state: 's',
    });
    expect(done.json()).toEqual({ status: 'connected' });
    expect((await list()).strava!.state).toBe('connected');

    const rec = fake.users.get('u-bo')!.providers.find((p) => p.provider_type === 'strava')!;
    await expect.poll(() => rec.syncs).toBeGreaterThan(0);
    expect(rec.sync_frequency).toBe('hourly');
    // A linked app is enough to stop the "connect a source" nudge.
    expect(((await call('GET', '/api/me/today')).json() as TodayResponse).hasSources).toBe(true);
  });

  it('syncs on demand and disconnects', async () => {
    const rec = fake.users.get('u-bo')!.providers.find((p) => p.provider_type === 'strava')!;
    const before = rec.syncs;
    expect((await call('POST', '/api/connections/strava/sync')).json()).toEqual({ ok: true });
    await expect.poll(() => rec.syncs).toBeGreaterThan(before);
    expect((await call('POST', '/api/connections/strava/disconnect')).json()).toEqual({ ok: true });
    expect((await list()).strava!.state).toBe('disconnected');
    expect((await call('POST', '/api/connections/strava/sync')).statusCode).toBe(400);
  });

  it('connects Hevy with an API key and refuses a wrong one in plain words', async () => {
    const wrong = await call('POST', '/api/connections/hevy/connect', { apiKey: 'not-a-real-key' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({
      code: 'provider_key',
      error: "Hevy didn't accept that API key. Check it and try again.",
    });
    expect((await list()).hevy!.state).toBe('disconnected');

    const ok = await call('POST', '/api/connections/hevy/connect', { apiKey: 'good-hevy-key' });
    expect(ok.json()).toEqual({ status: 'connected' });
    expect((await list()).hevy!.state).toBe('connected');
    expect(ok.body).not.toContain('good-hevy-key');
    await call('POST', '/api/connections/hevy/disconnect');
    expect((await list()).hevy!.state).toBe('disconnected');
  });

  it('refuses an app the server has no keys for, and bad requests', async () => {
    const res = await call('POST', '/api/connections/polar/connect');
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ code: 'oauth_not_configured' });
    expect((await call('POST', '/api/connections/hevy/connect', {})).statusCode).toBe(400);
    expect((await call('POST', '/api/connections/nope/connect', {})).statusCode).toBe(404);
  });

  it('switches wger on and off', async () => {
    await call('POST', '/api/connections/wger/connect');
    expect((await list()).wger!.state).toBe('connected');
    await call('POST', '/api/connections/wger/disconnect');
    expect((await list()).wger!.state).toBe('disconnected');
  });

  it('needs a signed-in user', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/connections' });
    expect(res.statusCode).toBe(401);
  });
});
