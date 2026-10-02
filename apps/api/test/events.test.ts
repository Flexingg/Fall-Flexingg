import type { ChallengeDetail, ChallengeEventsResponse, MeUser } from '@gauntlet/shared';
import { SparkyClient } from '@gauntlet/sparky';
import { FakeSparky } from '@gauntlet/sparky/testing';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { clearEventsCache } from '../src/services/events.js';
import { syncUser } from '../src/services/sync.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/gauntlet_test';
const fake = new FakeSparky();
let app: FastifyInstance;
let ctx: AppContext;
let closeDb: () => Promise<void>;
const clock = new Date('2026-10-02T18:00:00Z');
const names = { ann: 'Ann Lee', bob: 'Bob Ray', cy: 'Cy Moss', dee: 'Dee Fox' } as const;
type Who = keyof typeof names;
const access = {} as Record<Who, string>;
const ids = {} as Record<Who, string>;

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
  for (const who of Object.keys(names) as Who[]) {
    const u = fake.addUser({
      id: `u-${who}`,
      email: `${who}@example.com`,
      password: 'pw',
      name: names[who],
    });
    u.daily.push({ entry_date: '2026-10-01', source_provider: 'garmin', total_steps: 8000 });
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
  fake.users.get('u-ann')!.exerciseEntries.push({
    entry_date: '2026-10-01',
    exercise_name: 'Running',
    duration_minutes: 40,
    calories_burned: 450,
    exercise_source: 'garmin',
  });
  fake.users.get('u-bob')!.exerciseEntries.push({
    entry_date: '2026-10-01',
    exercise_name: 'Cycling',
    duration_minutes: 60,
    calories_burned: 600,
  });
  fake.users.get('u-ann')!.exerciseEntries.push({
    entry_date: '2026-10-02',
    exercise_name: 'Squat',
    sets: [{ set_type: 'Working Set', reps: 5, weight: 100 }],
  });
});

beforeEach(() => clearEventsCache());

afterAll(async () => {
  await app.close();
  await closeDb();
});

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

const base = { startDate: '2026-10-01', endDate: '2026-10-07', timezone: 'UTC' };
let ch: ChallengeDetail;
const events = (who: Who, q: string, expect = 200) =>
  call<ChallengeEventsResponse>(
    who,
    'GET',
    `/api/challenges/${ch.id}/events?${q}`,
    undefined,
    expect,
  );

describe('Show Events', () => {
  it('is off by default, and then nobody gets events', async () => {
    for (const who of ['bob', 'dee'] as const) {
      await call('ann', 'POST', '/api/friends/requests', { email: `${who}@example.com` });
      await call(who, 'POST', `/api/friends/requests/${ids.ann}/accept`);
    }
    const off = await call<ChallengeDetail>(
      'ann',
      'POST',
      '/api/challenges',
      {
        ...base,
        name: 'Calories',
        metric: 'active_calories',
        scoring: 'total',
        inviteUserIds: [ids.bob, ids.dee],
      },
      201,
    );
    expect(off.showEvents).toBe(false);
    await call('ann', 'GET', `/api/challenges/${off.id}/events?date=2026-10-01`, undefined, 403);
    ch = await call<ChallengeDetail>('ann', 'PATCH', `/api/challenges/${off.id}`, {
      showEvents: true,
    });
    expect(ch.showEvents).toBe(true);
    for (const who of ['bob', 'dee'] as const)
      await call(who, 'POST', `/api/challenges/${ch.id}/respond`, { accept: true });
    for (const who of Object.keys(names) as Who[]) await syncUser(ctx, ids[who]);
  });

  it('lists the workout behind a score, yours first, read live from SparkyFitness', async () => {
    const r = await events('ann', 'date=2026-10-01');
    expect(r.more).toBe(0);
    expect(r.groups.map((g) => [g.user.displayName, g.isMe, g.status])).toEqual([
      ['Ann Lee', true, 'ok'],
      ['Bob Ray', false, 'ok'],
      ['Dee Fox', false, 'ok'],
    ]);
    expect(r.groups[0]!.events).toEqual([
      expect.objectContaining({
        kind: 'workout',
        title: 'Running',
        detail: '40 min · 450 kcal',
        source: 'garmin',
      }),
    ]);
    expect(r.groups[1]!.events[0]).toMatchObject({ title: 'Cycling', detail: '60 min · 600 kcal' });
    expect(r.groups[2]!.events).toEqual([]);
  });

  it('reads each person once, then serves repeats from a short cache', async () => {
    fake.calls.length = 0;
    await events('ann', 'date=2026-10-01');
    const first = fake.calls.filter((c) => c.includes('/api/reports')).length;
    expect(first).toBe(3);
    await events('bob', 'date=2026-10-01');
    expect(fake.calls.filter((c) => c.includes('/api/reports')).length).toBe(first);
  });

  it('can ask for one person', async () => {
    const r = await events('ann', `date=2026-10-01&userId=${ids.bob}`);
    expect(r.groups.map((g) => g.user.displayName)).toEqual(['Bob Ray']);
  });

  it('hides people who keep their workouts private, but their totals still count', async () => {
    await call('bob', 'PATCH', '/api/me', { settings: { shareEvents: false } });
    const r = await events('ann', 'date=2026-10-01');
    expect(r.groups.find((g) => g.user.displayName === 'Bob Ray')).toMatchObject({
      status: 'hidden',
      events: [],
    });
    const mine = await events('bob', 'date=2026-10-01');
    expect(mine.groups[0]).toMatchObject({ isMe: true, status: 'ok' });
    expect(mine.groups[0]!.events).toHaveLength(1);
    const d = await call<ChallengeDetail>('ann', 'GET', `/api/challenges/${ch.id}`);
    expect(d.standings.find((s) => s.user.displayName === 'Bob Ray')!.score).toBe(600);
  });

  it('shows a person whose SparkyFitness cannot be reached as unavailable', async () => {
    fake.revokeAllKeys('u-dee');
    const r = await events('ann', 'date=2026-10-01');
    expect(r.groups.find((g) => g.user.displayName === 'Dee Fox')!.status).toBe('unavailable');
    expect(r.groups[0]!.status).toBe('ok');
  });

  it('is for joined participants only, even when the challenge is public', async () => {
    await events('cy', 'date=2026-10-01', 403);
    await call('ann', 'PATCH', '/api/me', { visibility: 'public' });
    await call('ann', 'PATCH', `/api/challenges/${ch.id}`, { visibility: 'public' });
    await call('cy', 'GET', `/api/challenges/${ch.id}`); // can look at the leaderboard
    await events('cy', 'date=2026-10-01', 403); // but not at anyone's workouts
  });

  it('only covers days the challenge has reached', async () => {
    await events('ann', 'date=2026-09-30', 400);
    await events('ann', 'date=2026-10-05', 400);
    await events('ann', 'date=nope', 400);
    await events('ann', `date=2026-10-01&userId=${ids.cy}`, 404);
  });

  it('lists only the chosen exercise in a one-lift challenge', async () => {
    fake.users.get('u-bob')!.exerciseEntries.push({
      entry_date: '2026-10-02',
      exercise_name: 'Bench Press',
      sets: [{ reps: 5, weight: 80 }],
    });
    const lift = await call<ChallengeDetail>(
      'ann',
      'POST',
      '/api/challenges',
      {
        ...base,
        name: 'Squat-off',
        metric: 'lift_max:squat',
        scoring: 'best_day',
        showEvents: true,
      },
      201,
    );
    const r = await call<ChallengeEventsResponse>(
      'ann',
      'GET',
      `/api/challenges/${lift.id}/events?date=2026-10-02`,
    );
    expect(r.groups[0]!.events.map((e) => [e.kind, e.title, e.detail])).toEqual([
      ['lift', 'Squat', '1 set · top 100 kg × 5 · 500 kg volume'],
    ]);
  });

  it('lists the day total for metrics with no single item, without calling SparkyFitness', async () => {
    const steps = await call<ChallengeDetail>(
      'ann',
      'POST',
      '/api/challenges',
      {
        ...base,
        name: 'Steps',
        metric: 'steps',
        scoring: 'total',
        showEvents: true,
      },
      201,
    );
    await syncUser(ctx, ids.ann);
    fake.calls.length = 0;
    const r = await call<ChallengeEventsResponse>(
      'ann',
      'GET',
      `/api/challenges/${steps.id}/events?date=2026-10-01`,
    );
    expect(r.groups[0]!.events).toEqual([
      expect.objectContaining({ kind: 'day', title: 'Steps', detail: '8,000', source: 'garmin' }),
    ]);
    expect(fake.calls.filter((c) => c.includes('/api/reports'))).toEqual([]);
  });

  it('never lists weight', async () => {
    const w = await call<ChallengeDetail>(
      'ann',
      'POST',
      '/api/challenges',
      {
        ...base,
        name: 'Weight',
        metric: 'weight_goal',
        scoring: 'total',
        showEvents: true,
        params: { weightGoal: { direction: 'lose', targetType: 'kg', target: 3 } },
      },
      201,
    );
    const r = await call<ChallengeEventsResponse>(
      'ann',
      'GET',
      `/api/challenges/${w.id}/events?date=2026-10-01`,
    );
    expect(r.groups[0]!.events).toEqual([]);
  });
});
