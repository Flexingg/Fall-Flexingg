import type { GarminLoginResult, GarminStatus } from '@gauntlet/shared';
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
fake.garminAccounts.set('runner@garmin.test', { password: 'garmin-pw' });
fake.garminAccounts.set('mfa@garmin.test', { password: 'garmin-pw', mfaCode: '246810' });
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
  });
  ({ app } = await buildApp({
    db,
    cfg,
    sparky: new SparkyClient({ baseUrl: fake.baseUrl, fetch: fake.fetch }),
    now: () => new Date(),
  }));
  closeDb = () => client.end();
  fake.addUser({ id: 'u-ann', email: 'ann@example.com', password: 'pw-ann', name: 'Ann' });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { method: 'password', email: 'ann@example.com', password: 'pw-ann' },
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

describe('Garmin Connect through the app', () => {
  it('starts unlinked, connects with email and password, and syncs in the background', async () => {
    expect((await call('GET', '/api/garmin')).json()).toMatchObject({ linked: false });

    const res = await call('POST', '/api/garmin/login', {
      email: 'runner@garmin.test',
      password: 'garmin-pw',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as GarminLoginResult).toEqual({ status: 'connected' });
    expect(((await call('GET', '/api/garmin')).json() as GarminStatus).linked).toBe(true);

    // The 30-day pull starts right away, without making the person wait for it.
    await expect.poll(() => fake.users.get('u-ann')!.garmin!.syncs).toBeGreaterThan(0);
    // Garmin's data reached SparkyFitness as its own source.
    expect(fake.users.get('u-ann')!.daily.some((r) => r.source_provider === 'garmin')).toBe(true);
  });

  it('syncs on demand and disconnects', async () => {
    const before = fake.users.get('u-ann')!.garmin!.syncs;
    expect((await call('POST', '/api/garmin/sync')).json()).toEqual({ ok: true });
    await expect.poll(() => fake.users.get('u-ann')!.garmin!.syncs).toBeGreaterThan(before);

    expect((await call('POST', '/api/garmin/disconnect')).json()).toEqual({ ok: true });
    expect(((await call('GET', '/api/garmin')).json() as GarminStatus).linked).toBe(false);
    expect((await call('POST', '/api/garmin/sync')).statusCode).toBe(400);
  });

  it('asks for the code when Garmin does, and accepts the right one', async () => {
    const step1 = await call('POST', '/api/garmin/login', {
      email: 'mfa@garmin.test',
      password: 'garmin-pw',
    });
    const body = step1.json() as Extract<GarminLoginResult, { status: 'needs_mfa' }>;
    expect(body.status).toBe('needs_mfa');
    expect(((await call('GET', '/api/garmin')).json() as GarminStatus).linked).toBe(false);

    const wrong = await call('POST', '/api/garmin/login/mfa', {
      clientState: body.clientState,
      code: '000000',
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ code: 'garmin_mfa' });

    // A wrong code uses up that attempt (Garmin's service forgets it), so sign in again.
    const again = (
      await call('POST', '/api/garmin/login', { email: 'mfa@garmin.test', password: 'garmin-pw' })
    ).json() as typeof body;
    const ok = await call('POST', '/api/garmin/login/mfa', {
      clientState: again.clientState,
      code: '246810',
    });
    expect(ok.json()).toEqual({ status: 'connected' });
    expect(((await call('GET', '/api/garmin')).json() as GarminStatus).linked).toBe(true);
    await call('POST', '/api/garmin/disconnect');
  });

  it('explains wrong passwords and an unreachable Garmin service in plain words', async () => {
    const bad = await call('POST', '/api/garmin/login', {
      email: 'runner@garmin.test',
      password: 'nope',
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({
      code: 'garmin_credentials',
      error: "Garmin didn't accept that email and password.",
    });

    fake.garminDown = true;
    const down = await call('POST', '/api/garmin/login', {
      email: 'runner@garmin.test',
      password: 'garmin-pw',
    });
    fake.garminDown = false;
    expect(down.statusCode).toBe(502);
    expect(down.json()).toMatchObject({ code: 'garmin_unreachable' });
  });

  it('never stores or echoes the Garmin password', async () => {
    const res = await call('POST', '/api/garmin/login', {
      email: 'runner@garmin.test',
      password: 'garmin-pw',
    });
    expect(res.body).not.toContain('garmin-pw');
    await call('POST', '/api/garmin/disconnect');
  });

  it('needs a signed-in user', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/garmin' });
    expect(res.statusCode).toBe(401);
  });
});
