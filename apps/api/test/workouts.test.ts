import type {
  ChallengeDetail,
  ChallengeEventsResponse,
  MeUser,
  WorkoutDetail,
  WorkoutsResponse,
} from '@gauntlet/shared';
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
const clock = new Date('2026-10-02T18:00:00Z');
const names = { ann: 'Ann Lee', bob: 'Bob Ray', cy: 'Cy Moss' } as const;
type Who = keyof typeof names;
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

beforeAll(async () => {
  const { db, client } = createDb(DB_URL);
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
  closeDb = () => client.end();
  for (const who of Object.keys(names) as Who[]) {
    fake.addUser({
      id: `u-${who}`,
      email: `${who}@example.com`,
      password: 'pw',
      name: names[who],
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
  fake.users.get('u-ann')!.exerciseEntries.push(
    {
      id: 'run-1',
      entry_date: '2026-10-01',
      exercise_name: 'running',
      duration_minutes: 40,
      calories_burned: 450,
      exercise_source: 'garmin',
      distance: 6.2,
      avg_heart_rate: 151.4,
      start_time: '2026-10-01T07:30:00Z',
    },
    // SparkyFitness' whole-day total is not a workout.
    { entry_date: '2026-10-01', exercise_name: 'Active Calories', calories_burned: 900 },
    {
      entry_date: '2026-10-02',
      exercise_name: 'Squat',
      exercise_source: 'liftosaur',
      sets: [
        { set_type: 'Warm-up', reps: 5, weight: 60 },
        { set_type: 'Working Set', reps: 5, weight: 100 },
        { set_type: 'Working Set', reps: 3, weight: 110 },
      ],
    },
    {
      entry_date: '2026-10-02',
      exercise_name: 'Bench Press',
      exercise_source: 'liftosaur',
      sets: [{ set_type: 'Working Set', reps: 8, weight: 60 }],
    },
    // Older than the default 30 days.
    {
      entry_date: '2026-08-01',
      exercise_name: 'Rowing',
      duration_minutes: 20,
      calories_burned: 200,
    },
  );
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

const base = { startDate: '2026-10-01', endDate: '2026-10-07', timezone: 'UTC' };
const workout = (who: Who, id: string, of?: Who, expect = 200) =>
  call<WorkoutDetail>(
    who,
    'GET',
    `/api/workouts/${id}${of ? `?userId=${ids[of]}` : ''}`,
    undefined,
    expect,
  );

describe('your workouts', () => {
  it('lists the last 30 days, newest first, without day totals', async () => {
    const r = await call<WorkoutsResponse>('ann', 'GET', '/api/me/workouts');
    expect(r.workouts.map((w) => [w.id, w.name, w.kind])).toEqual([
      ['2026-10-02.s-liftosaur', 'Strength workout · 2 exercises', 'strength'],
      ['2026-10-01.run-1', 'Running', 'cardio'],
    ]);
    expect(r.workouts[1]).toMatchObject({
      source: 'Garmin',
      minutes: 40,
      kcal: 450,
      distanceKm: 6.2,
      summary: '40 min · 6.2 km · 450 kcal',
    });
    expect(r.workouts[0]).toMatchObject({
      summary: '3 sets · 1,310 kg volume',
      source: 'Liftosaur',
    });
  });

  it('takes a days window', async () => {
    const r = await call<WorkoutsResponse>('ann', 'GET', '/api/me/workouts?days=1');
    expect(r.workouts.map((w) => w.id)).toEqual(['2026-10-02.s-liftosaur']);
    const all = await call<WorkoutsResponse>('ann', 'GET', '/api/me/workouts?days=90');
    expect(all.workouts).toHaveLength(3);
    await call('ann', 'GET', '/api/me/workouts?days=500', undefined, 400);
  });

  it('is empty for someone with no workouts', async () => {
    expect((await call<WorkoutsResponse>('cy', 'GET', '/api/me/workouts')).workouts).toEqual([]);
  });

  it('opens a cardio workout with its numbers', async () => {
    const w = await workout('ann', '2026-10-01.run-1');
    expect(w).toMatchObject({
      name: 'Running',
      date: '2026-10-01',
      startedAt: '2026-10-01T07:30:00.000Z',
      source: 'Garmin',
      minutes: 40,
      kcal: 450,
      distanceKm: 6.2,
      avgHeartRate: 151,
      exercises: [],
      owner: { displayName: 'Ann Lee', isMe: true },
    });
  });

  it('opens a strength session with sets, warm-ups marked, volume and best 1RM', async () => {
    const w = await workout('ann', '2026-10-02.s-liftosaur');
    expect(w.volumeKg).toBe(5 * 100 + 3 * 110 + 8 * 60);
    expect(w.exercises.map((e) => e.name)).toEqual(['Squat', 'Bench Press']);
    const squat = w.exercises[0]!;
    expect(squat.sets.map((s) => [s.reps, s.kg, s.warmup])).toEqual([
      [5, 60, true],
      [5, 100, false],
      [3, 110, false],
    ]);
    // Warm-ups don't count toward volume or 1RM. Epley: 100 x 5 = 116.7, 110 x 3 = 121.
    expect(squat.volumeKg).toBe(830);
    expect(squat.bestE1rm).toBeCloseTo(121, 5);
    expect(squat.sets[0]!.e1rm).toBeNull();
    expect(w.exercises[1]!.bestE1rm).toBeCloseTo(76, 5);
  });

  it('does not find things that are not there', async () => {
    await workout('ann', '2026-10-01.nope', undefined, 404);
    await workout('ann', '2026-10-05.run-1', undefined, 404);
    await workout('ann', 'garbage', undefined, 404);
    await workout('ann', '2026-10-01.run-1', 'cy', 404);
    await call('ann', 'GET', '/api/workouts/2026-10-01.run-1?userId=nope', undefined, 400);
  });
});

describe('other people’s workouts', () => {
  let calories: ChallengeDetail;
  it('stay private to strangers and to challenge-mates without Show Events', async () => {
    await workout('bob', '2026-10-01.run-1', 'ann', 404);
    for (const who of ['bob', 'cy'] as const) {
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
        inviteUserIds: [ids.bob],
      },
      201,
    );
    await call('bob', 'POST', `/api/challenges/${off.id}/respond`, { accept: true });
    // Friends, in a challenge together, but Show Events is off.
    await workout('bob', '2026-10-01.run-1', 'ann', 404);
    calories = await call<ChallengeDetail>('ann', 'PATCH', `/api/challenges/${off.id}`, {
      showEvents: true,
    });
  });

  it('open where Show Events would show them', async () => {
    const w = await workout('bob', '2026-10-01.run-1', 'ann');
    expect(w).toMatchObject({
      name: 'Running',
      minutes: 40,
      owner: { displayName: 'Ann Lee', isMe: false },
    });
    // Source and heart rate follow "show my data sources", which is on by default.
    expect(w.source).toBe('Garmin');
  });

  it('link from the events list', async () => {
    const r = await call<ChallengeEventsResponse>(
      'bob',
      'GET',
      `/api/challenges/${calories.id}/events?date=2026-10-01&userId=${ids.ann}`,
    );
    expect(r.groups[0]!.events[0]).toMatchObject({
      kind: 'workout',
      workoutId: '2026-10-01.run-1',
    });
  });

  it('stay hidden for kinds the challenge does not list, days it has not reached, and outsiders', async () => {
    // A calories challenge lists workouts, not lift sessions.
    await workout('bob', '2026-10-02.s-liftosaur', 'ann', 404);
    // The challenge hasn't reached Oct 5.
    fake.users.get('u-ann')!.exerciseEntries.push({
      entry_date: '2026-10-05',
      exercise_name: 'Swim',
      duration_minutes: 30,
      calories_burned: 300,
    });
    await workout('bob', '2026-10-05.n0', 'ann', 404);
    // Cy is Ann's friend but not in the challenge.
    await workout('cy', '2026-10-01.run-1', 'ann', 404);
  });

  it('respect the owner keeping workouts private', async () => {
    await call('ann', 'PATCH', '/api/me', { settings: { shareEvents: false } });
    await workout('bob', '2026-10-01.run-1', 'ann', 404);
    await workout('ann', '2026-10-01.run-1'); // still hers
    await call('ann', 'PATCH', '/api/me', { settings: { shareEvents: true } });
  });

  it('hide the source and heart rate for people who keep data sources private', async () => {
    await call('ann', 'PATCH', '/api/me', { settings: { shareWorkoutDetails: false } });
    const w = await workout('bob', '2026-10-01.run-1', 'ann');
    expect(w.source).toBeNull();
    expect(w.avgHeartRate).toBeNull();
    expect(w.minutes).toBe(40);
    await call('ann', 'PATCH', '/api/me', { settings: { shareWorkoutDetails: true } });
  });

  it('show lift sessions through a lifting challenge, only the scored exercise for a single lift', async () => {
    const squat = await call<ChallengeDetail>(
      'ann',
      'POST',
      '/api/challenges',
      {
        ...base,
        name: 'Squat-off',
        metric: 'lift_max:squat',
        scoring: 'best_day',
        showEvents: true,
        inviteUserIds: [ids.bob],
      },
      201,
    );
    await call('bob', 'POST', `/api/challenges/${squat.id}/respond`, { accept: true });
    const w = await workout('bob', '2026-10-02.s-liftosaur', 'ann');
    expect(w.exercises.map((e) => e.name)).toEqual(['Squat']);
    expect(w.name).toBe('Squat');
    // Bench volume must not leak through the totals.
    expect(w.volumeKg).toBe(830);

    const volume = await call<ChallengeDetail>(
      'ann',
      'POST',
      '/api/challenges',
      {
        ...base,
        name: 'Volume',
        metric: 'lift_volume',
        scoring: 'total',
        showEvents: true,
        inviteUserIds: [ids.bob],
      },
      201,
    );
    await call('bob', 'POST', `/api/challenges/${volume.id}/respond`, { accept: true });
    const all = await workout('bob', '2026-10-02.s-liftosaur', 'ann');
    expect(all.exercises.map((e) => e.name)).toEqual(['Squat', 'Bench Press']);
  });
});
