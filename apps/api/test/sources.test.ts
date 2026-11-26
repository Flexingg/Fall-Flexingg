import type { MeUser, SourcePriorityResponse, SyncResponse } from '@gauntlet/shared';
import { SparkyClient } from '@gauntlet/sparky';
import { FakeSparky, type FakeUser } from '@gauntlet/sparky/testing';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, runMigrations, type Db } from '../src/db/index.js';
import { dailyMetrics } from '../src/db/schema.js';
import { resetPullCooldowns } from '../src/services/pull.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/gauntlet_test';
const fake = new FakeSparky();
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
let app: FastifyInstance;
let db: Db;
let closeDb: () => Promise<void>;
let token = '';
let userId = '';
let ana: FakeUser;

async function call<T = unknown>(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: object,
  expect = 200,
) {
  const res = await app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.statusCode !== expect)
    throw new Error(`${method} ${url} -> ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}

async function steps(date: string) {
  const [row] = await db
    .select({ value: dailyMetrics.value, source: dailyMetrics.source })
    .from(dailyMetrics)
    .where(
      and(
        eq(dailyMetrics.userId, userId),
        eq(dailyMetrics.date, date),
        eq(dailyMetrics.metric, 'steps'),
      ),
    );
  return row;
}

beforeAll(async () => {
  const created = createDb(DB_URL);
  db = created.db;
  await db.execute(
    sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`,
  );
  await runMigrations(db);
  ({ app } = await buildApp({
    db,
    cfg: loadConfig({
      DATABASE_URL: DB_URL,
      SPARKY_URL: fake.baseUrl,
      PUBLIC_WEB_URL: 'https://gauntlet.test',
      JWT_SECRET: 'test-secret-test-secret-test-secret-123',
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      SYNC_INTERVAL_MINUTES: '0',
    }),
    sparky: new SparkyClient({ baseUrl: fake.baseUrl, fetch: fake.fetch }),
    now: () => new Date(),
  }));
  closeDb = () => created.client.end();

  // A watch and the phone both count yesterday's steps; the phone says more.
  const signIn = ['src', 'test'].join('-');
  ana = fake.addUser({ id: 'u-ana', email: 'ana@example.com', password: signIn, name: 'Ana Lima' });
  ana.daily.push({ entry_date: yesterday, source_provider: 'garmin', total_steps: 9000 });
  ana.checkIns.push(
    { entry_date: yesterday, steps: 9500, updated_at: `${yesterday}T20:00:00Z` },
    { entry_date: today, steps: 6000, updated_at: `${today}T20:00:00Z` },
  );
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { method: 'password', email: ana.email, password: signIn },
    headers: { 'x-gauntlet-client': 'native' },
  });
  const body = res.json() as { accessToken: string; user: MeUser };
  token = body.accessToken;
  userId = body.user.id;
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe('choosing which source counts', () => {
  it('offers the sources it has seen, automatic by default', async () => {
    await call('POST', '/api/me/sync');
    expect(await steps(yesterday)).toMatchObject({ value: 9500 });
    const p = await call<SourcePriorityResponse>('GET', '/api/me/source-priority');
    expect(p.metrics.find((m) => m.key === 'steps')).toEqual({
      key: 'steps',
      label: 'Steps',
      preferred: null,
      sources: [
        { key: 'garmin', label: 'Garmin' },
        { key: 'health_connect', label: 'Health Connect & phone' },
      ],
    });
  });

  it('prefers a source per metric, re-syncs, and can go back to automatic', async () => {
    const p = await call<SourcePriorityResponse>('PUT', '/api/me/source-priority', {
      metric: 'steps',
      preferred: 'garmin',
    });
    expect(p.metrics.find((m) => m.key === 'steps')!.preferred).toBe('garmin');
    expect(await steps(yesterday)).toMatchObject({ value: 9000, source: 'garmin' });
    // Garmin has nothing today, so the phone's count is used rather than none.
    expect(await steps(today)).toMatchObject({ value: 6000 });

    await call('PUT', '/api/me/source-priority', { metric: 'steps', preferred: null });
    expect(await steps(yesterday)).toMatchObject({ value: 9500 });
  });

  it('rejects metrics that have no choice to make', async () => {
    await call('PUT', '/api/me/source-priority', { metric: 'workouts', preferred: 'garmin' }, 400);
  });
});

describe('pulling fresh data', () => {
  it('asks connected apps to pull, then picks up what they bring', async () => {
    resetPullCooldowns();
    ana.garmin = { linkedAt: new Date().toISOString(), syncs: 0 };
    await call('PUT', '/api/me/source-priority', { metric: 'steps', preferred: 'garmin' });

    const r = await call<SyncResponse>('POST', '/api/me/sync', { providers: true });
    expect(r).toMatchObject({ ok: true, pulling: ['Garmin Connect'] });
    // The fake Garmin pull adds 4,321 steps for today; Gauntlet re-reads once it's done.
    await vi.waitFor(async () => expect(await steps(today)).toMatchObject({ value: 4321 }), {
      timeout: 5000,
    });
    expect(ana.garmin.syncs).toBe(1);

    // A second tap straight away only re-reads; it doesn't ask Garmin again.
    const again = await call<SyncResponse>('POST', '/api/me/sync', { providers: true });
    expect(again.pulling).toEqual([]);
    expect(ana.garmin.syncs).toBe(1);
  });

  it('a plain sync never contacts the apps', async () => {
    resetPullCooldowns();
    const r = await call<SyncResponse>('POST', '/api/me/sync', {});
    expect(r.pulling).toEqual([]);
    expect(ana.garmin!.syncs).toBe(1);
  });
});
