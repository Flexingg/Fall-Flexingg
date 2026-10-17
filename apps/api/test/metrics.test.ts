import type {
  ChallengeDetail,
  ChallengeProgress,
  FastStatus,
  LiftOption,
  MeUser,
  TrendsOverview,
  TrendsResponse,
  WallpaperResponse,
} from '@gauntlet/shared';
import { SparkyClient } from '@gauntlet/sparky';
import { FakeSparky, type FakeUser } from '@gauntlet/sparky/testing';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { syncUser } from '../src/services/sync.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/gauntlet_test';
const fake = new FakeSparky();
let app: FastifyInstance;
let ctx: AppContext;
let closeDb: () => Promise<void>;
const clock = new Date('2026-10-02T18:00:00Z');
const people = { bulk: 'Bo Bulk', cut: 'Cy Cut' } as const;
type Who = keyof typeof people;
const access = {} as Record<Who, string>;
const ids = {} as Record<Who, string>;
const sparkyUser = {} as Record<Who, FakeUser>;

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
    sparkyUser[who] = fake.addUser({
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
  // Friends, so they can invite each other.
  await call('bulk', 'POST', '/api/friends/requests', { email: 'cut@example.com' });
  await call('cut', 'POST', `/api/friends/requests/${ids.bulk}/accept`);
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

async function call<T = unknown>(
  who: Who,
  method: 'GET' | 'POST',
  url: string,
  payload?: object,
  expect = method === 'POST' && url === '/api/challenges' ? 201 : 200,
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

const base = {
  startDate: '2026-10-01',
  endDate: '2026-10-07',
  timezone: 'UTC',
};
const syncAll = async () => {
  for (const who of Object.keys(people) as Who[]) await syncUser(ctx, ids[who]);
};

describe('calorie adherence', () => {
  it('lets a bulker and a cutter both score 100 by hitting their own goals', async () => {
    sparkyUser.bulk.goals.push({ from: '2026-01-01', goals: { calories: 3200, protein: 200 } });
    sparkyUser.cut.goals.push({ from: '2026-01-01', goals: { calories: 1800, protein: 160 } });
    sparkyUser.bulk.nutrition.push(
      { date: '2026-10-01', calories: 3200, protein: 200 },
      { date: '2026-10-02', calories: 3200, protein: 200 },
    );
    sparkyUser.cut.nutrition.push(
      { date: '2026-10-01', calories: 1800, protein: 160 },
      { date: '2026-10-02', calories: 1980, protein: 160 }, // 10% over: 80
    );
    const ch = await call<ChallengeDetail>('bulk', 'POST', '/api/challenges', {
      ...base,
      name: 'Dial it in',
      metric: 'calorie_adherence',
      scoring: 'daily_avg',
      inviteUserIds: [ids.cut],
    });
    await call('cut', 'POST', `/api/challenges/${ch.id}/respond`, { accept: true });
    await syncAll();
    const d = await call<ChallengeDetail>('bulk', 'GET', `/api/challenges/${ch.id}`);
    expect(d.standings.map((s) => [s.user.displayName, s.score])).toEqual([
      ['Bo Bulk', 100],
      ['Cy Cut', 90],
    ]);
    // Goals were looked up once per logged day and are not looked up again for settled days.
    const before = fake.calls.filter((c) => c.includes('/api/goals/')).length;
    await syncAll();
    const after = fake.calls.filter((c) => c.includes('/api/goals/')).length;
    expect(after - before).toBe(4); // today and yesterday, for each of the two
  });

  it('refuses a way of winning that makes no sense for the metric', async () => {
    await call(
      'bulk',
      'POST',
      '/api/challenges',
      { ...base, name: 'x', metric: 'weight_goal', scoring: 'streak', goal: 1 },
      400,
    );
  });
});

describe('weight goal', () => {
  let ch: ChallengeDetail;
  const lose = { direction: 'lose', targetType: 'kg', target: 4 } as const;
  const gain = { direction: 'gain', targetType: 'percent', target: 5 } as const;

  it('needs everyone to pick their own target', async () => {
    const body = { ...base, name: 'Recomp', metric: 'weight_goal', scoring: 'total' };
    const res = await app.inject({
      method: 'POST',
      url: '/api/challenges',
      payload: body,
      headers: { authorization: `Bearer ${access.bulk}` },
    });
    expect(res.json()).toMatchObject({ code: 'needs_weight_goal' });
    ch = await call<ChallengeDetail>('bulk', 'POST', '/api/challenges', {
      ...body,
      params: { weightGoal: gain },
      inviteUserIds: [ids.cut],
    });
    expect(ch.myParams).toEqual({ weightGoal: gain });
    await call('cut', 'POST', `/api/challenges/${ch.id}/respond`, { accept: true }, 400);
    await call('cut', 'POST', `/api/challenges/${ch.id}/respond`, {
      accept: true,
      params: { weightGoal: lose },
    });
  });

  it('scores % of each person’s own target and never shows weights', async () => {
    sparkyUser.bulk.checkIns.push(
      { entry_date: '2026-09-29', weight: 70, updated_at: '2026-09-29T07:00:00Z' },
      { entry_date: '2026-10-02', weight: 71.75, updated_at: '2026-10-02T07:00:00Z' },
    );
    sparkyUser.cut.checkIns.push(
      { entry_date: '2026-10-01', weight: 90, updated_at: '2026-10-01T07:00:00Z' },
      { entry_date: '2026-10-02', weight: 89, updated_at: '2026-10-02T07:00:00Z' },
    );
    await syncAll();
    const d = await call<ChallengeDetail>('cut', 'GET', `/api/challenges/${ch.id}`);
    // Bo gained 1.75 of 3.5 kg (5% of 70); Cy lost 1 of 4 kg.
    expect(d.standings.map((s) => [s.user.displayName, s.score])).toEqual([
      ['Bo Bulk', 50],
      ['Cy Cut', 25],
    ]);
    const text = JSON.stringify(d);
    // No raw weight appears as a value anywhere (ids can contain the digits, so match numbers only).
    expect(text).not.toMatch(/[:,[](71\.75|89|90|70)[,}\]]/);
    expect(d.myParams).toEqual({ weightGoal: lose });
  });
});

describe('strength', () => {
  it('lists exercises with weighted sets and races on the heaviest squat', async () => {
    sparkyUser.bulk.exerciseEntries.push({
      entry_date: '2026-10-01',
      exercise_name: 'Squat',
      exercise_source: 'liftosaur',
      sets: [
        { set_type: 'Warm-up', reps: 5, weight: 60 },
        { set_type: 'Working Set', reps: 5, weight: 140 },
      ],
    });
    sparkyUser.cut.exerciseEntries.push({
      entry_date: '2026-10-02',
      exercise_name: 'Squat',
      sets: [{ reps: 3, weight: 120 }],
    });
    const lifts = await call<LiftOption[]>('bulk', 'GET', '/api/me/lifts');
    expect(lifts).toEqual([{ key: 'squat', label: 'Squat', sessions: 1 }]);
    const ch = await call<ChallengeDetail>('bulk', 'POST', '/api/challenges', {
      ...base,
      name: 'Squat-off',
      metric: 'lift_max:squat',
      scoring: 'best_day',
      inviteUserIds: [ids.cut],
    });
    expect(ch.metricLabel).toBe('Squat max');
    await call('cut', 'POST', `/api/challenges/${ch.id}/respond`, { accept: true });
    await syncAll();
    const d = await call<ChallengeDetail>('bulk', 'GET', `/api/challenges/${ch.id}`);
    expect(d.standings.map((s) => s.score)).toEqual([140, 120]);
  });
});

describe('fasting', () => {
  it('starts and ends a fast through Gauntlet', async () => {
    expect(await call<FastStatus>('cut', 'GET', '/api/me/fast')).toEqual({ active: null });
    const started = await call<FastStatus>('cut', 'POST', '/api/me/fast/start', { hours: 16 });
    expect(started.active?.targetEndAt).toBe('2026-10-03T10:00:00.000Z');
    await call('cut', 'POST', '/api/me/fast/start', { hours: 16 }, 400);
    expect((await call<FastStatus>('cut', 'GET', '/api/me/fast')).active?.id).toBe(
      started.active!.id,
    );
    await call('cut', 'POST', '/api/me/fast/end');
    expect(await call<FastStatus>('cut', 'GET', '/api/me/fast')).toEqual({ active: null });
    await call('cut', 'POST', '/api/me/fast/end', undefined, 400);
  });
});

describe('progress graph data', () => {
  it('ends every line on the leaderboard score and flips nothing for higher-is-better', async () => {
    const ch = await call<ChallengeDetail>('bulk', 'POST', '/api/challenges', {
      ...base,
      name: 'Squat graph',
      metric: 'lift_max:squat',
      scoring: 'best_day',
      inviteUserIds: [ids.cut],
    });
    await call('cut', 'POST', `/api/challenges/${ch.id}/respond`, { accept: true });
    await syncAll();
    const detail = await call<ChallengeDetail>('bulk', 'GET', `/api/challenges/${ch.id}`);
    const p = await call<ChallengeProgress>('bulk', 'GET', `/api/challenges/${ch.id}/progress`);
    expect(p.dates[0]).toBe('2026-10-01');
    expect(p.dates.at(-1)).toBe('2026-10-02'); // the clock is on the 2nd
    expect(p.truncated).toBe(false);
    expect(p.lowerIsBetter).toBe(false);
    expect(p.series.map((s) => s.user.displayName)).toEqual(['Bo Bulk', 'Cy Cut']);
    expect(p.series.find((s) => s.isMe)?.user.displayName).toBe('Bo Bulk');
    for (const s of p.series) {
      const row = detail.standings.find((r) => r.user.id === s.user.id)!;
      expect(s.values.at(-1)).toBe(row.score);
      expect(s.rank).toBe(row.rank);
    }
    // Bo lifted 140 on the 1st; Cy 120 on the 2nd.
    expect(p.series[0]!.values).toEqual([140, 140]);
    expect(p.series[1]!.values).toEqual([null, 120]);
  });

  it('is not shown to people outside a private challenge', async () => {
    const ch = await call<ChallengeDetail>('bulk', 'POST', '/api/challenges', {
      ...base,
      name: 'Private one',
      metric: 'steps',
      scoring: 'total',
    });
    await call('cut', 'GET', `/api/challenges/${ch.id}/progress`, undefined, 403);
  });
});

describe('Trends covers every stat', () => {
  it('stores goals, weight, every exercise and custom measurements without any challenge asking', async () => {
    const u = sparkyUser.bulk;
    u.categories.push({ id: 'c-mood', name: 'Mood', frequency: 'Daily', data_type: 'numeric' });
    u.custom['c-mood'] = [
      { date: '2026-10-01', value: '6', timestamp: '2026-10-01T10:00:00Z' },
      { date: '2026-10-02', value: '8', timestamp: '2026-10-02T10:00:00Z' },
    ];
    u.exerciseEntries.push({
      entry_date: '2026-10-02',
      exercise_name: 'Deadlift',
      sets: [{ reps: 3, weight: 150 }],
    });
    await syncUser(ctx, ids.bulk);

    const o = await call<TrendsOverview>('bulk', 'GET', '/api/me/trends/overview?range=day');
    const keys = o.available.map((a) => a.key);
    for (const k of [
      'calorie_adherence',
      'macro_adherence',
      'calories_in',
      'weight',
      'lift_max:squat',
      'lift_e1rm:deadlift',
      'custom:mood',
    ])
      expect(keys, k).toContain(k);
    // Stored goals and per-challenge scores aren't offered.
    expect(keys.filter((k) => k.startsWith('goal_') || k === 'weight_goal')).toEqual([]);
    expect(o.items.find((i) => i.key === 'weight')).toMatchObject({
      total: 71.75,
      aggregate: 'last',
    });
    expect(o.items.find((i) => i.key === 'lift_max:squat')).toMatchObject({
      total: 140,
      aggregate: 'max',
    });
    expect(o.items.find((i) => i.key === 'custom:mood')).toMatchObject({ total: 7, label: 'Mood' });
  });

  it('charts any of them', async () => {
    const w = await call<TrendsResponse>('bulk', 'GET', '/api/me/trends?range=day&metric=weight');
    expect(w.def).toMatchObject({ label: 'Weight', unit: 'kg', aggregate: 'last' });
    expect(w.total).toBe(71.75);
    const lift = await call<TrendsResponse>(
      'bulk',
      'GET',
      `/api/me/trends?range=day&metric=${encodeURIComponent('lift_max:squat')}`,
    );
    expect(lift.def.label).toBe('Squat heaviest set');
    await call('bulk', 'GET', '/api/me/trends?range=day&metric=goal_calories', undefined, 400);
    await call('bulk', 'GET', '/api/me/trends?range=day&metric=nonsense', undefined, 400);
  });
});

describe('live wallpaper', () => {
  it("reports today's food against the person's own goals", async () => {
    const w = await call<WallpaperResponse>('bulk', 'GET', '/api/me/wallpaper');
    expect(w).toMatchObject({
      date: '2026-10-02',
      timezone: 'UTC',
      calories: { value: 3200, goal: 3200 },
      protein: { value: 200, goal: 200 },
    });
    expect(w.volume.goal).toBeGreaterThan(0);
    const c = await call<WallpaperResponse>('cut', 'GET', '/api/me/wallpaper');
    expect(c.calories).toEqual({ value: 1980, goal: 1800 });
  });
});
