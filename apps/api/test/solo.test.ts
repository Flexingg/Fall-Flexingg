import type {
  ChallengeDetail,
  ChallengeProgress,
  ChallengeSummary,
  DiscoverResponse,
  MeUser,
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
let access = '';
let myId = '';
let sparky: FakeUser;
const clock = new Date('2026-10-05T18:00:00Z');

const day = (offset: number) =>
  new Date(clock.getTime() + offset * 86_400_000).toISOString().slice(0, 10);

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
  sparky = fake.addUser({ id: 'u-solo', email: 'solo@example.com', password: 'pw', name: 'Sol O' });
  // 88 days of 6,000 steps back in the summer (the "past"), then 10,000 a day since Oct 1.
  for (let i = -90; i <= -6; i++) sparky.daily.push({ entry_date: day(i), total_steps: 6000 });
  for (let i = -4; i <= -1; i++) sparky.daily.push({ entry_date: day(i), total_steps: 10000 });
  sparky.daily.push({ entry_date: day(0), total_steps: 4000 });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { method: 'password', email: 'solo@example.com', password: 'pw' },
    headers: { 'x-gauntlet-client': 'native', 'x-timezone': 'UTC' },
  });
  const body = res.json() as { accessToken: string; user: MeUser };
  access = body.accessToken;
  myId = body.user.id;
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

async function call<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
  expect = method === 'POST' && url === '/api/challenges' ? 201 : 200,
): Promise<T> {
  const res = await app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${access}` },
  });
  if (res.statusCode !== expect)
    throw new Error(`${method} ${url} -> ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}
const create = (body: object, expect = 201) =>
  call<ChallengeDetail>(
    'POST',
    '/api/challenges',
    {
      name: 'Solo',
      timezone: 'UTC',
      startDate: day(-4),
      endDate: day(5),
      scoring: 'total',
      metric: 'steps',
      ...body,
    },
    expect,
  );

describe('solo challenges', () => {
  it('hit a total: tracks pace against an even split of the goal', async () => {
    const ch = await create({ solo: { kind: 'target' }, goal: 50_000 });
    expect(ch).toMatchObject({
      participantCount: 1,
      visibility: 'private',
      soloConfig: { kind: 'target' },
    });
    expect(ch.metricLabel).toBe('Steps total');
    await syncUser(ctx, myId);
    const d = await call<ChallengeDetail>('GET', `/api/challenges/${ch.id}`);
    // 44,000 steps in 5 of 10 days; an even pace to 50,000 is 25,000.
    expect(d.solo).toMatchObject({
      kind: 'target',
      status: 'ahead',
      current: 44_000,
      target: 50_000,
      expected: 25_000,
      remaining: 6000,
      daysLeft: 5,
      daysElapsed: 5,
    });
    expect(d.solo!.perDayNeeded).toBeCloseTo(1200, 5);
    const g = await call<ChallengeProgress>('GET', `/api/challenges/${ch.id}/progress`);
    expect(g).toMatchObject({ target: 50_000, valueKind: 'metric' });
    expect(g.series).toHaveLength(1);
    expect(g.series[0]!.values.at(-1)).toBe(44_000);
  });

  it('is just for you: no invites, no public, not in Discover', async () => {
    const ch = await create({ solo: { kind: 'target' }, goal: 1000 });
    await call('POST', `/api/challenges/${ch.id}/invite`, { userIds: [myId] }, 400);
    await call('POST', '/api/invites', { kind: 'challenge', challengeId: ch.id }, 400);
    await call('PATCH', `/api/challenges/${ch.id}`, { visibility: 'public' }, 400);
    await create({ solo: { kind: 'target' }, goal: 1000, visibility: 'public' }, 400);
    await create({ solo: { kind: 'target' }, goal: 1000, inviteUserIds: [myId] }, 400);
    const d = await call<DiscoverResponse>('GET', '/api/challenges/discover');
    expect(d.challenges).toEqual([]);
    // You can still rename it and show events, and delete it any time.
    await call('PATCH', `/api/challenges/${ch.id}`, { name: 'Mine', showEvents: true });
    await call('DELETE', `/api/challenges/${ch.id}`);
  });

  it('daily average: judged against the goal', async () => {
    const ch = await create({ solo: { kind: 'average' }, goal: 8000 });
    await syncUser(ctx, myId);
    const d = await call<ChallengeDetail>('GET', `/api/challenges/${ch.id}`);
    // 44,000 over 5 elapsed days = 8,800 a day, 10% over the goal.
    expect(d.solo).toMatchObject({ kind: 'average', status: 'ahead', current: 8800, progress: 1 });
    expect(d.metricLabel).toBe('Steps per day');
  });

  it('streak: days in a row at or above the daily target', async () => {
    const ch = await create({ solo: { kind: 'streak', days: 4 }, goal: 10_000 });
    await syncUser(ctx, myId);
    const d = await call<ChallengeDetail>('GET', `/api/challenges/${ch.id}`);
    expect(d.solo).toMatchObject({
      kind: 'streak',
      current: 4,
      target: 4,
      status: 'achieved',
      valueKind: 'days',
    });
    expect(d.unit).toBe('days');
    const list = await call<ChallengeSummary[]>('GET', '/api/challenges');
    expect(list.find((c) => c.id === ch.id)).toMatchObject({
      myScore: 4,
      solo: { status: 'achieved' },
    });
  });

  it('beat my past self: % change against the days before it started, read from far back', async () => {
    const ch = await create({
      name: 'Beat summer me',
      solo: { kind: 'improve', changePct: 10, direction: 'up', baselineDays: 90 },
    });
    expect(ch.goal).toBeNull();
    expect(ch.metricLabel).toBe('Steps vs before');
    await syncUser(ctx, myId);
    const d = await call<ChallengeDetail>('GET', `/api/challenges/${ch.id}`);
    // The 90 days before Oct 1 hold 85 days of 6,000 (the sync window reached back far enough).
    expect(d.solo!.baseline).toMatchObject({ from: day(-94), to: day(-5), days: 90 });
    const base = d.solo!.baseline!.value;
    expect(base).toBeCloseTo((85 * 6000) / 90, 3);
    // Now: 44,000 over 5 days = 8,800 a day.
    expect(d.solo!.current).toBeCloseTo((8800 / base - 1) * 100, 3);
    expect(d.solo).toMatchObject({ status: 'ahead', valueKind: 'pct', target: 10, progress: 1 });
    expect(d.unit).toBe('%');
    const g = await call<ChallengeProgress>('GET', `/api/challenges/${ch.id}/progress`);
    expect(g).toMatchObject({ valueKind: 'pct', target: 10 });
    expect(g.series[0]!.values.at(-1)).toBeCloseTo(d.solo!.current!, 3);
  });

  it('refuses nonsense in plain words', async () => {
    const bad = async (body: object) =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/challenges',
          payload: {
            name: 'x',
            timezone: 'UTC',
            startDate: day(0),
            endDate: day(5),
            scoring: 'total',
            metric: 'steps',
            ...body,
          },
          headers: { authorization: `Bearer ${access}` },
        })
      ).json() as { error: string };
    expect((await bad({ solo: { kind: 'target' } })).error).toMatch(/number to aim for/);
    expect((await bad({ solo: { kind: 'streak', days: 30 }, goal: 100 })).error).toMatch(
      /longer than the challenge/,
    );
    expect((await bad({ metric: 'sleep', solo: { kind: 'target' }, goal: 100 })).error).toMatch(
      /add up/,
    );
    expect(
      (await bad({ metric: 'weight_goal', solo: { kind: 'average' }, goal: 1 })).error,
    ).toMatch(/Hit a total/);
  });

  it('weight: aim at 100% of your own target', async () => {
    sparky.checkIns.push(
      { entry_date: day(-6), weight: 80, updated_at: `${day(-6)}T07:00:00Z` },
      { entry_date: day(-1), weight: 78.5, updated_at: `${day(-1)}T07:00:00Z` },
    );
    const ch = await create({
      metric: 'weight_goal',
      solo: { kind: 'target' },
      params: { weightGoal: { direction: 'lose', targetType: 'kg', target: 3 } },
    });
    expect(ch.goal).toBe(100);
    await syncUser(ctx, myId);
    const d = await call<ChallengeDetail>('GET', `/api/challenges/${ch.id}`);
    expect(d.solo).toMatchObject({ kind: 'target', current: 50, target: 100 });
  });
});
