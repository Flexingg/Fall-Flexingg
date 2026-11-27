/**
 * Health Connect readings read back from SparkyFitness (0.17): they reach their owner's day screen
 * and Trends, and nobody else, ever. Also: every stored value explains itself (daily_metrics.detail)
 * and keeps doing so without a "change" when only the explanation moves.
 */
import {
  HEALTH_METRIC_KEYS,
  type DayResponse,
  type MeUser,
  type TrendsOverview,
  type TrendsResponse,
} from '@gauntlet/shared';
import { SparkyClient } from '@gauntlet/sparky';
import { FakeSparky, type FakeUser } from '@gauntlet/sparky/testing';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { dailyMetrics, feedEvents, users } from '../src/db/schema.js';
import { syncUser } from '../src/services/sync.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/gauntlet_test';
const fake = new FakeSparky();
let app: FastifyInstance;
let ctx: AppContext;
let closeDb: () => Promise<void>;
const clock = new Date('2026-10-02T18:00:00Z');
const people = { ana: 'Ana Lima', ben: 'Ben Ortiz' } as const;
type Who = keyof typeof people;
const access = {} as Record<Who, string>;
const ids = {} as Record<Who, string>;
const sparky = {} as Record<Who, FakeUser>;
const DAY = '2026-10-01';

async function call<T = unknown>(
  who: Who,
  method: 'GET' | 'POST',
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

const metricRow = (who: Who, metric: string, date = DAY) =>
  ctx.db
    .select()
    .from(dailyMetrics)
    .where(
      and(
        eq(dailyMetrics.userId, ids[who]),
        eq(dailyMetrics.date, date),
        eq(dailyMetrics.metric, metric),
      ),
    )
    .then((r) => r[0]);

/** Numbers nobody else would have by chance, so a leak is easy to spot in a response body. */
const HRV = 71.37;
const HR_AVG = 63.41;

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
  ({ app, ctx } = await buildApp({
    db,
    cfg,
    sparky: new SparkyClient({ baseUrl: fake.baseUrl, fetch: fake.fetch }),
    now: () => clock,
  }));
  closeDb = () => client.end();
  for (const who of Object.keys(people) as Who[]) {
    sparky[who] = fake.addUser({
      id: `u-${who}`,
      email: `${who}@example.com`,
      password: 'pw',
      name: people[who],
    });
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
  await call('ana', 'POST', '/api/friends/requests', { email: 'ben@example.com' });
  await call('ben', 'POST', `/api/friends/requests/${ids.ana}/accept`);
  // Ana shares her stats, so a friend really can read her profile.
  await ctx.db.update(users).set({ shareProfileStats: true }).where(eq(users.id, ids.ana));

  const a = sparky.ana;
  const cat = (id: string, name: string, rows: [string, number][]) => {
    a.categories.push({ id, name, data_type: 'numeric', frequency: 'Daily' });
    a.custom[id] = rows.map(([date, value]) => ({
      date,
      value,
      timestamp: `${date}T07:00:00Z`,
    }));
  };
  cat('c-hrv', 'hrv', [
    [DAY, HRV],
    ['2026-09-30', 55.5],
  ]);
  cat('c-hr', 'heart_rate_avg', [[DAY, HR_AVG]]);
  cat('c-hrmax', 'heart_rate_max', [[DAY, 171.25]]);
  cat('c-spo2', 'oxygen_saturation', [[DAY, 96.5]]);
  cat('c-mood', 'Mood', [[DAY, 4]]);
  a.daily.push({
    entry_date: DAY,
    source_provider: 'garmin',
    total_steps: 9000,
    total_calories: 2650.5,
  });
  a.checkIns.push({
    entry_date: DAY,
    steps: 8200,
    weight: 81.5,
    body_fat_percentage: 18.7,
    height: 181,
    bmr: 1733,
    updated_at: '2026-10-01T20:00:00Z',
  });
  // Ben does the same, so there is something to compare with.
  sparky.ben.daily.push({ entry_date: DAY, source_provider: 'garmin', total_steps: 7000 });
  await syncUser(ctx, ids.ana);
  await syncUser(ctx, ids.ben);
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe('reading Health Connect data back', () => {
  it('stores each reading under its Gauntlet key, from custom categories and check-ins', async () => {
    const stored = async (m: string) => (await metricRow('ana', m))?.value;
    expect(await stored('hrv')).toBe(HRV);
    expect(await stored('hr_avg')).toBe(HR_AVG);
    expect(await stored('hr_max')).toBe(171.25);
    expect(await stored('spo2')).toBe(96.5);
    expect(await stored('total_calories')).toBe(2650.5);
    expect(await stored('body_fat')).toBe(18.7);
    expect(await stored('height')).toBe(181);
    expect(await stored('bmr')).toBe(1733);
    // Not also an "extra" custom measurement; unrelated ones still are.
    expect(await metricRow('ana', 'custom:hrv')).toBeUndefined();
    expect(await metricRow('ana', 'custom:heart_rate_avg')).toBeUndefined();
    expect((await metricRow('ana', 'custom:mood'))?.value).toBe(4);
  });

  it('shows them to their owner on the day screen and Trends', async () => {
    const day = await call<DayResponse>('ana', 'GET', `/api/me/day?date=${DAY}`);
    const stats = Object.fromEntries(
      day.sections.flatMap((s) => s.stats.map((st) => [st.key, st.value])),
    );
    expect(stats).toMatchObject({
      hrv: HRV,
      hr_avg: HR_AVG,
      body_fat: 18.7,
      total_calories: 2650.5,
    });
    expect(day.sections.find((s) => s.key === 'sleep')?.label).toBe('Sleep, heart and vitals');
    const overview = await call<TrendsOverview>(
      'ana',
      'GET',
      '/api/me/trends/overview?range=month',
    );
    expect(overview.available.map((a) => a.key)).toEqual(expect.arrayContaining(['hrv', 'spo2']));
    const t = await call<TrendsResponse>('ana', 'GET', '/api/me/trends?metric=hrv&range=month');
    expect(t.def).toMatchObject({ label: 'Heart rate variability', unit: 'ms', aggregate: 'avg' });
  });

  it('drops a value once SparkyFitness no longer has it', async () => {
    sparky.ana.custom['c-hr'] = [];
    await syncUser(ctx, ids.ana);
    expect(await metricRow('ana', 'hr_avg')).toBeUndefined();
    expect(await metricRow('ana', 'hrv')).toBeDefined();
  });
});

describe('health readings are private to their owner', () => {
  const secrets = [
    ...HEALTH_METRIC_KEYS.map((k) => `"${k}"`),
    String(HRV),
    '171.25',
    '2650.5',
    '18.7',
    '1733',
  ];
  const expectClean = (body: unknown) => {
    const text = JSON.stringify(body);
    for (const s of secrets) expect(text).not.toContain(s);
  };

  it('never appears in what a friend can open about her', async () => {
    // Make her a challenge opponent and put something in the feed, so those paths are exercised too.
    const ch = await call<{ id: string }>(
      'ana',
      'POST',
      '/api/challenges',
      {
        name: 'Step duel',
        metric: 'steps',
        scoring: 'total',
        startDate: '2026-10-01',
        endDate: '2026-10-07',
        timezone: 'UTC',
        inviteUserIds: [ids.ben],
      },
      201,
    );
    await call('ben', 'POST', `/api/challenges/${ch.id}/respond`, { accept: true });
    await syncUser(ctx, ids.ana);
    await syncUser(ctx, ids.ben);
    const id = ids.ana;
    for (const url of [
      `/api/users/${id}`,
      `/api/users/${id}/profile`,
      `/api/users/${id}/compare`,
      `/api/users/${id}/badges`,
      `/api/users/${id}/badges/timeline`,
      `/api/users/${id}/heatmap?metric=steps`,
      '/api/feed',
      `/api/challenges/${ch.id}`,
      '/api/challenges',
      '/api/friends',
    ]) {
      expectClean(await call('ben', 'GET', url));
    }
    // And she does see her own (the secrets above are real data).
    expect(JSON.stringify(await call('ana', 'GET', `/api/me/day?date=${DAY}`))).toContain(
      String(HRV),
    );
  });

  it('cannot be charted on a profile heatmap', async () => {
    await call('ben', 'GET', `/api/users/${ids.ana}/heatmap?metric=hrv`, undefined, 400);
  });

  it('is not offered as a challenge metric and cannot be made one', async () => {
    const offered = await call<{ label: string }[]>('ana', 'GET', '/api/me/custom-metrics');
    expect(offered.map((o) => o.label.toLowerCase())).not.toContain('hrv');
    const hrvId = sparky.ana.categories.find((c) => c.name === 'hrv')!.id;
    await call(
      'ana',
      'POST',
      '/api/challenges',
      {
        name: 'My heart',
        metric: 'custom:hrv',
        scoring: 'daily_avg',
        startDate: '2026-10-01',
        endDate: '2026-10-07',
        timezone: 'UTC',
        inviteUserIds: [ids.ben],
        custom: { categoryId: hrvId, label: 'HRV', aggregate: 'avg', lowerIsBetter: false },
      },
      400,
    );
  });

  it('is never written to the feed when it changes', async () => {
    sparky.ana.custom['c-hrv']![0]!.value = 80.5;
    await syncUser(ctx, ids.ana);
    const events = await ctx.db.select().from(feedEvents);
    expectClean(events);
  });
});

describe('where each value came from (detail)', () => {
  it('records every source that reported and why one won', async () => {
    const steps = await metricRow('ana', 'steps');
    expect(steps).toMatchObject({ value: 9000, source: 'garmin' });
    expect(steps?.detail).toEqual({
      rule: 'highest',
      candidates: [
        { source: 'garmin', value: 9000 },
        { source: 'check-in', value: 8200 },
      ],
    });
    expect((await metricRow('ana', 'hrv'))?.detail).toMatchObject({ rule: 'only' });
  });

  it('updates source and detail when only they change, without announcing a change', async () => {
    const before = await metricRow('ana', 'steps');
    const feedBefore = (await ctx.db.select().from(feedEvents)).length;
    // Another source reports less than the winner: same value, new explanation.
    sparky.ana.daily.push({ entry_date: DAY, source_provider: 'fitbit', total_steps: 4100 });
    const res = await syncUser(ctx, ids.ana);
    const after = await metricRow('ana', 'steps');
    expect(after?.value).toBe(9000);
    expect(after?.detail?.candidates.map((c) => c.source)).toContain('fitbit');
    expect(res.changed).toBe(0);
    // Nothing "changed", so the value's own timestamp stays and no post appears.
    expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
    expect((await ctx.db.select().from(feedEvents)).length).toBe(feedBefore);

    // The winner changes source at the same number: stored, still not a change.
    for (const d of sparky.ana.daily) if (d.source_provider === 'garmin') d.total_steps = null;
    sparky.ana.checkIns[0]!.steps = 9000;
    const res2 = await syncUser(ctx, ids.ana);
    const moved = await metricRow('ana', 'steps');
    expect(moved?.value).toBe(9000);
    expect(moved?.source).toBe('check-in');
    expect(res2.changed).toBe(0);
  });

  it('stores a new detail along with a changed value', async () => {
    sparky.ana.checkIns[0]!.steps = 9500;
    const res = await syncUser(ctx, ids.ana);
    expect(res.changed).toBeGreaterThan(0);
    const row = await metricRow('ana', 'steps');
    expect(row?.value).toBe(9500);
    expect(row?.detail?.candidates).toContainEqual({ source: 'check-in', value: 9500 });
  });
});
