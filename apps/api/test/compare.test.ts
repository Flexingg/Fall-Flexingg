import type { CompareResponse, MeUser } from '@gauntlet/shared';
import { SparkyClient } from '@gauntlet/sparky';
import { FakeSparky } from '@gauntlet/sparky/testing';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, runMigrations, type Db } from '../src/db/index.js';
import { challengeParticipants, challenges, dailyMetrics } from '../src/db/schema.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/gauntlet_test';
const fake = new FakeSparky();
let app: FastifyInstance;
let db: Db;
let closeDb: () => Promise<void>;
// Thursday Oct 1: the week is Mon Sep 28 .. Sun Oct 4, "7 days" is Sep 25 .. Oct 1.
const clock = new Date('2026-10-01T12:00:00Z');
const people = {
  ana: 'Ana Lima',
  ben: 'Ben Ortiz',
  cat: 'Cat Anderson',
  dan: 'Dan Reyes',
  eve: 'Eve Stone',
};
type Who = keyof typeof people;
const access = {} as Record<Who, string>;
const ids = {} as Record<Who, string>;

async function call<T = unknown>(
  who: Who,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: object,
  expect = 200,
): Promise<T> {
  const res = await app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${access[who]}` },
  });
  if (res.statusCode !== expect)
    throw new Error(`${method} ${url} -> ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}

async function finished(name: string, ranks: [Who, number, number | null][], solo = false) {
  const [ch] = await db
    .insert(challenges)
    .values({
      name,
      metric: 'steps',
      aggregate: 'sum',
      scoring: 'total',
      startDate: '2026-09-01',
      endDate: '2026-09-07',
      timezone: 'UTC',
      createdBy: ids[ranks[0]![0]],
      solo: solo ? ({ kind: 'total', target: 1 } as never) : null,
      finalizedAt: new Date('2026-09-08T00:00:00Z'),
    })
    .returning();
  await db.insert(challengeParticipants).values(
    ranks.map(([who, rank, score]) => ({
      challengeId: ch!.id,
      userId: ids[who],
      state: 'joined' as const,
      finalRank: rank,
      finalScore: score,
    })),
  );
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
    now: () => clock,
  }));
  closeDb = () => created.client.end();
  for (const [who, name] of Object.entries(people) as [Who, string][]) {
    fake.addUser({ id: `u-${who}`, email: `${who}@example.com`, password: 'pw', name });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { method: 'password', email: `${who}@example.com`, password: 'pw' },
      headers: { 'x-gauntlet-client': 'native', 'x-timezone': 'UTC' },
    });
    const body = res.json() as { accessToken: string; user: MeUser };
    access[who] = body.accessToken;
    ids[who] = body.user.id;
  }
  // Ana is friends with Ben (who shares stats) and Cat (who doesn't).
  for (const who of ['ben', 'cat'] as const) {
    await call('ana', 'POST', '/api/friends/requests', { email: `${who}@example.com` });
    await call(who, 'POST', `/api/friends/requests/${ids.ana}/accept`);
  }
  await call('ben', 'PATCH', '/api/me', { settings: { shareProfileStats: true } });

  const v = (who: Who, date: string, metric: string, value: number) => ({
    userId: ids[who],
    date,
    metric,
    value,
  });
  await db.insert(dailyMetrics).values([
    // Ana: this week 5,000 + 6,000 + 7,000 steps; last week 4,000 on the same Monday.
    v('ana', '2026-09-28', 'steps', 5000),
    v('ana', '2026-09-29', 'steps', 6000),
    v('ana', '2026-10-01', 'steps', 7000),
    v('ana', '2026-09-21', 'steps', 4000),
    v('ana', '2026-09-29', 'distance', 8),
    v('ana', '2026-09-30', 'workouts', 1),
    // Never part of a comparison.
    v('ana', '2026-09-29', 'weight', 81.5),
    v('ana', '2026-09-29', 'sleep', 7),
    v('ana', '2026-09-29', 'calories_in', 2500),
    // Ben.
    v('ben', '2026-09-30', 'steps', 9000),
    v('ben', '2026-09-26', 'steps', 3000), // Saturday of last week: only in "7 days"
    v('ben', '2026-09-30', 'distance', 5),
    v('ben', '2026-09-30', 'lift_volume', 4000),
    v('ben', '2026-09-30', 'weight', 90),
    v('cat', '2026-09-30', 'steps', 20_000),
  ]);

  await finished('Ana vs Ben 1', [
    ['ana', 1, 500],
    ['ben', 2, 300],
  ]);
  await finished('Ana vs Ben 2', [
    ['ben', 1, 900],
    ['ana', 2, 800],
  ]);
  await finished('Ana vs Ben 3', [
    ['ana', 1, 50],
    ['ben', 2, 40],
    ['cat', 3, 10],
  ]);
  // Not counted: a solo challenge, and one where Ben never scored.
  await finished('Solo', [['ana', 1, 100]], true);
  await finished('Walkover', [
    ['ana', 1, 50],
    ['ben', 2, null],
  ]);
  await finished('Ana and Dan', [
    ['dan', 1, 9],
    ['ana', 2, 8],
  ]);
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

const compare = (viewer: Who, of: Who, q = '', expect = 200) =>
  call<CompareResponse>(viewer, 'GET', `/api/users/${ids[of]}/compare${q}`, undefined, expect);

describe('head to head', () => {
  it('is not available for strangers, bad ids or yourself', async () => {
    await compare('eve', 'ana', '', 404);
    await call('eve', 'GET', '/api/users/not-a-uuid/compare', undefined, 404);
    await compare('ana', 'ana', '', 400);
  });

  it('compares the week with the same totals Trends shows', async () => {
    const r = await compare('ana', 'ben');
    expect(r).toMatchObject({ range: 'week', theirsHidden: false, theirName: 'Ben Ortiz' });
    expect(r.metrics).toEqual([
      { key: 'steps', label: 'Steps', unit: '', me: 18_000, them: 9000 },
      { key: 'distance', label: 'Distance', unit: 'km', me: 8, them: 5 },
      { key: 'workouts', label: 'Workouts', unit: '', me: 1, them: 0 },
      { key: 'lift_volume', label: 'Volume lifted', unit: 'kg', me: 0, them: 4000 },
    ]);
    const trends = await call<{ total: number }>(
      'ana',
      'GET',
      '/api/me/trends?range=week&metric=steps',
    );
    expect(trends.total).toBe(r.metrics[0]!.me);
  });

  it('follows the range picker', async () => {
    const days = await compare('ana', 'ben', '?range=day');
    // Last 7 days reaches back to Sep 25, so Ben's Saturday counts.
    expect(days.metrics.find((m) => m.key === 'steps')).toMatchObject({ me: 18_000, them: 12_000 });
    const month = await compare('ana', 'ben', '?range=month');
    expect(month.range).toBe('month');
    expect(month.metrics.find((m) => m.key === 'steps')).toMatchObject({
      me: 22_000,
      them: 12_000,
    });
    await compare('ana', 'ben', '?range=year', 400);
  });

  it('counts wins in challenges you both finished, and nothing else', async () => {
    const r = await compare('ana', 'ben');
    expect(r.record).toEqual({ me: 2, them: 1, shared: 3 });
    // From the other side it flips.
    expect((await compare('ben', 'ana')).record).toEqual({ me: 1, them: 2, shared: 3 });
  });

  it('shows only the record, no numbers, when they do not share stats', async () => {
    const r = await compare('ana', 'cat');
    expect(r).toMatchObject({
      theirsHidden: true,
      metrics: [],
      record: { me: 1, them: 0, shared: 1 },
    });
    expect(JSON.stringify(r)).not.toContain('20000');
    // A challenge-mate who is not a friend can be compared too, with the record only.
    const shared = await compare('ana', 'dan');
    expect(shared).toMatchObject({ theirsHidden: true, metrics: [] });
    expect(shared.record).toEqual({ me: 0, them: 1, shared: 1 });
  });

  it('never includes weight, food or sleep', async () => {
    const r = await compare('ana', 'ben');
    const keys = r.metrics.map((m) => m.key);
    for (const banned of ['weight', 'sleep', 'calories_in']) expect(keys).not.toContain(banned);
  });

  it('follows them turning sharing on and off', async () => {
    await call('cat', 'PATCH', '/api/me', { settings: { shareProfileStats: true } });
    expect((await compare('ana', 'cat')).metrics[0]).toMatchObject({ key: 'steps', them: 20_000 });
    await call('cat', 'PATCH', '/api/me', { settings: { shareProfileStats: false } });
    expect((await compare('ana', 'cat')).theirsHidden).toBe(true);
  });
});
