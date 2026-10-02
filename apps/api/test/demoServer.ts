/**
 * Runs the real API against an in-memory SparkyFitness with a seeded crew,
 * for UI development and screenshots. Never use in production.
 *
 *   DATABASE_URL=postgres://... pnpm --filter @gauntlet/api demo
 *
 * Sign in as you@example.com / demo (or maya@, dre@, sam@, jordan@ / demo).
 * Connect screens: Hevy key good-hevy-key; Strava/Fitbit sign-in code good-code.
 * Garmin screen: runner@garmin.demo / demo, or mfa@garmin.demo / demo with code 123456.
 */
import { addDays, todayIn } from '@gauntlet/shared';
import { sql } from 'drizzle-orm';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { runSyncCycle } from '../src/scheduler.js';
import { SparkyClient } from '@gauntlet/sparky';
import { FakeSparky, type FakeUser } from '@gauntlet/sparky/testing';

const DB_URL = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/gauntlet';
const TZ = process.env.DEMO_TZ ?? 'America/Los_Angeles';
const fake = new FakeSparky();
const today = todayIn(TZ);
const d = (offset: number) => addDays(today, offset);

const people: [string, string, string][] = [
  ['you', 'Alex Morgan', 'you@example.com'],
  ['maya', 'Maya Rodriguez', 'maya@example.com'],
  ['dre', 'Dre Thomas', 'dre@example.com'],
  ['sam', 'Sam Kim', 'sam@example.com'],
  ['jordan', 'Jordan Lee', 'jordan@example.com'],
  // Strangers: Riley runs a public challenge; Casey is new and private (used by the browser tests).
  ['riley', 'Riley Park', 'riley@example.com'],
  ['casey', 'Casey Diaz', 'casey@example.com'],
];
const users: Record<string, FakeUser> = {};
for (const [id, name, email] of people)
  users[id] = fake.addUser({ id: `sparky-${id}`, email, password: 'demo', name });

// Two weeks of history; distance in metres, steps, minutes.
const profile: Record<string, { km: number[]; steps: number[]; source: string }> = {
  you: {
    km: [6.1, 8.4, 3.2, 10.5, 7.9, 12.3, 5.0, 9.8, 11.2, 4.4, 8.8, 14.1, 9.6, 6.1],
    steps: [
      8200, 11000, 6400, 13900, 9800, 15600, 7100, 10400, 12900, 6800, 11800, 18200, 12100, 9412,
    ],
    source: 'Health Connect',
  },
  maya: {
    km: [9.0, 7.2, 12.1, 6.6, 10.2, 8.8, 13.4, 9.9, 12.0, 7.7, 10.4, 13.6, 11.3, 10.2],
    steps: [
      12000, 9800, 15800, 9100, 13300, 11800, 17500, 12900, 15100, 10200, 13600, 18100, 14300,
      13200,
    ],
    source: 'garmin',
  },
  dre: {
    km: [4.0, 5.5, 6.1, 3.3, 7.8, 9.1, 2.2, 6.3, 4.9, 8.1, 5.0, 9.9, 6.5, 8.8],
    steps: [
      7000, 8100, 9300, 6200, 10900, 12100, 5100, 9200, 7900, 11300, 8200, 13100, 9800, 12000,
    ],
    source: 'strava',
  },
  sam: {
    km: [3.1, 4.4, 2.8, 6.0, 5.2, 4.1, 3.9, 5.5, 2.6, 6.8, 4.2, 7.1, 5.0, 3.0],
    steps: [6100, 7200, 5600, 9100, 8000, 6800, 6500, 8400, 5200, 9800, 7100, 10500, 8100, 6600],
    source: 'fitbit',
  },
  jordan: {
    km: [2.0, 3.5, 4.1, 2.2, 5.0, 3.3, 6.2, 2.9, 4.4, 3.1, 5.6, 2.4, 3.8, 4.0],
    steps: [5000, 6200, 7100, 4800, 8300, 6000, 9500, 5600, 7400, 5900, 8800, 5100, 6900, 7300],
    source: 'garmin',
  },
  riley: {
    km: [7.2, 8.1, 6.4, 9.9, 8.2, 7.7, 10.4, 6.9, 8.8, 9.3, 7.5, 11.0, 8.4, 7.9],
    steps: [
      11200, 12800, 10100, 14900, 12600, 11900, 15800, 10600, 13400, 14100, 11500, 16600, 12900,
      12100,
    ],
    source: 'polar',
  },
};
for (const [id, p] of Object.entries(profile)) {
  const u = users[id]!;
  p.km.forEach((km, i) => {
    const date = d(i - 13);
    u.daily.push({
      entry_date: date,
      source_provider: p.source,
      total_distance_meters: km * 1000,
      total_steps: p.steps[i],
      active_calories: Math.round(km * 62),
      exercise_minutes: Math.round(km * 6.5),
      resting_heart_rate: 50 + (id.length % 7),
    });
    if (km > 7) {
      u.exerciseDays.push({
        startDate: date,
        distanceMeters: km * 1000,
        durationMinutes: Math.round(km * 6),
        caloriesBurned: Math.round(km * 60),
        workoutCount: 1,
      });
      u.exerciseEntries.push({
        entry_date: date,
        exercise_name: 'Running',
        duration_minutes: Math.round(km * 6),
        calories_burned: Math.round(km * 60),
        exercise_source: p.source,
      });
    }
    u.sleep.push({
      entry_date: date,
      time_asleep_in_seconds: (6.5 + ((i + id.length) % 4) * 0.4) * 3600,
      source: p.source,
    });
  });
}

// Pretend Garmin accounts for trying the Connect Garmin screen.
fake.garminAccounts.set('runner@garmin.demo', { password: 'demo' });
// Food, water and goals: Alex is bulking, Maya is cutting. Alex lifts with Liftosaur.
const diet: Record<string, { goal: number; eats: number[] }> = {
  you: {
    goal: 2900,
    eats: [2950, 2700, 3100, 2880, 2600, 2920, 3050, 2890, 2810, 3300, 2900, 2860, 2940, 2100],
  },
  maya: {
    goal: 1800,
    eats: [1750, 1900, 1820, 2100, 1780, 1810, 1700, 1790, 1950, 1805, 1760, 1830, 1880, 1500],
  },
};
for (const [id, p] of Object.entries(diet)) {
  const u = users[id]!;
  u.goals.push({
    from: d(-60),
    goals: {
      calories: p.goal,
      protein: Math.round(p.goal / 16),
      carbs: Math.round(p.goal / 9),
      fat: Math.round(p.goal / 36),
      water_goal_ml: 2500,
    },
  });
  p.eats.forEach((kcal, i) =>
    u.nutrition.push({
      date: d(i - 13),
      calories: kcal,
      protein: Math.round(kcal / 16),
      carbs: Math.round(kcal / 9.5),
      fat: Math.round(kcal / 35),
    }),
  );
  for (let i = 0; i < 14; i++)
    u.water.push({ entry_date: d(i - 13), water_ml: 1800 + ((i * 337) % 900) });
}
for (let i = 0; i < 14; i += 2) {
  users.you!.exerciseEntries.push({
    entry_date: d(i - 13),
    exercise_name: 'Squat',
    exercise_source: 'liftosaur',
    duration_minutes: 0,
    sets: [
      { set_type: 'Warm-up', reps: 5, weight: 60 },
      ...[0, 1, 2].map(() => ({ set_type: 'Working Set', reps: 5, weight: 100 + i * 2.5 })),
    ],
  });
}
// A custom measurement and weigh-ins, so Trends has more than the built-ins to show.
users.you!.categories.push({
  id: 'cat-mood',
  name: 'Mood',
  frequency: 'Daily',
  data_type: 'numeric',
});
users.you!.custom['cat-mood'] = Array.from({ length: 14 }, (_, i) => ({
  date: d(i - 13),
  value: String(5 + ((i * 3) % 5)),
  timestamp: `${d(i - 13)}T20:00:00Z`,
}));
for (let i = 0; i < 14; i += 3)
  users.you!.checkIns.push({
    entry_date: d(i - 13),
    weight: 82 - i * 0.1,
    updated_at: `${d(i - 13)}T07:00:00Z`,
  });
users.you!.fasts.push({
  id: 'demo-fast-1',
  start_time: `${d(-2)}T03:00:00Z`,
  end_time: `${d(-2)}T19:00:00Z`,
  target_end_time: `${d(-2)}T19:00:00Z`,
  duration_minutes: 960,
  status: 'COMPLETED',
});

fake.garminAccounts.set('mfa@garmin.demo', { password: 'demo', mfaCode: '123456' });

const { db, client } = createDb(DB_URL);
await db.execute(
  sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`,
);
await runMigrations(db);
const cfg = loadConfig({
  ...process.env,
  DATABASE_URL: DB_URL,
  SPARKY_URL: fake.baseUrl,
  PUBLIC_WEB_URL: process.env.PUBLIC_WEB_URL ?? 'http://localhost:5173',
  // Pretend OAuth app keys, so Strava and Fitbit can be tried (Oura and Polar show as not set up).
  OAUTH_STRAVA_CLIENT_ID: 'demo-strava',
  OAUTH_STRAVA_CLIENT_SECRET: 'demo-secret',
  OAUTH_FITBIT_CLIENT_ID: 'demo-fitbit',
  OAUTH_FITBIT_CLIENT_SECRET: 'demo-secret',
  EXTRA_ORIGINS: 'http://localhost:4173,http://127.0.0.1:5173,http://127.0.0.1:4173',
  JWT_SECRET: process.env.JWT_SECRET ?? 'demo-secret-demo-secret-demo-secret-0000',
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 3).toString('base64'),
  SYNC_INTERVAL_MINUTES: '0',
  ADMIN_EMAILS: 'riley@example.com',
  // The browser tests sign in many times a minute.
  LOGIN_RATE_LIMIT_MAX: '1000',
});
const { app, ctx } = await buildApp(
  {
    db,
    cfg,
    sparky: new SparkyClient({ baseUrl: fake.baseUrl, fetch: fake.fetch }),
    now: () => new Date(),
  },
  { logger: { level: 'warn' } },
);

// Seed through the real API so the data is exactly what the app would create.
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
async function call<T>(
  who: string | null,
  method: string,
  url: string,
  payload?: unknown,
): Promise<T> {
  const res = await app.inject({
    method: method as 'GET',
    url,
    payload: payload as object,
    headers: {
      'x-gauntlet-client': 'native',
      'x-timezone': TZ,
      ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}),
    },
  });
  if (res.statusCode >= 400) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
  return res.json() as T;
}
for (const [id, , email] of people) {
  const r = await call<{ accessToken: string; user: { id: string } }>(
    null,
    'POST',
    '/api/auth/login',
    { method: 'password', email, password: 'demo' },
  );
  tokens[id] = r.accessToken;
  ids[id] = r.user.id;
}
for (const id of ['maya', 'dre', 'sam', 'jordan']) {
  await call('you', 'POST', '/api/friends/requests', { email: `${id}@example.com` });
  if (id !== 'jordan') await call(id, 'POST', `/api/friends/requests/${ids.you}/accept`);
}
await call('maya', 'POST', '/api/friends/requests', { email: 'dre@example.com' });
await call('dre', 'POST', `/api/friends/requests/${ids.maya}/accept`);

// A finished challenge last week (so results, wins and rank history exist).
const past = await call<{ id: string }>('maya', 'POST', '/api/challenges', {
  name: 'Step Wars',
  metric: 'steps',
  scoring: 'total',
  startDate: d(-12),
  endDate: today,
  timezone: TZ,
  inviteUserIds: [ids.you], // end date shortened below
});
await call('you', 'POST', `/api/challenges/${past.id}/respond`, { accept: true });
await call('maya', 'POST', `/api/challenges/${past.id}/invite`, { userIds: [ids.dre] });
await call('dre', 'POST', `/api/challenges/${past.id}/respond`, { accept: true });

// The live one from the mockups.
const live = await call<{ id: string }>('you', 'POST', '/api/challenges', {
  name: 'Weekend 100K',
  metric: 'distance',
  scoring: 'total',
  goal: 100,
  startDate: d(-4),
  endDate: d(2),
  timezone: TZ,
  inviteUserIds: [ids.maya, ids.dre, ids.sam],
});
for (const id of ['maya', 'dre', 'sam'])
  await call(id, 'POST', `/api/challenges/${live.id}/respond`, { accept: true });
// Show Events on the main challenge; Dre keeps his workouts private.
await call('you', 'PATCH', `/api/challenges/${live.id}`, { showEvents: true });
await call('dre', 'PATCH', '/api/me', { settings: { shareEvents: false } });
const cup = await call<{ id: string }>('dre', 'POST', '/api/challenges', {
  name: 'Active Minutes Cup',
  metric: 'active_minutes',
  scoring: 'daily_avg',
  startDate: d(-2),
  endDate: d(5),
  timezone: TZ,
  inviteUserIds: [ids.you, ids.maya],
});
await call('maya', 'POST', `/api/challenges/${cup.id}/respond`, { accept: true });

// Bulking vs cutting on the same leaderboard, and a fasting challenge.
const macro = await call<{ id: string }>('maya', 'POST', '/api/challenges', {
  name: 'Dial It In',
  metric: 'calorie_adherence',
  scoring: 'daily_avg',
  startDate: d(-6),
  endDate: d(7),
  timezone: TZ,
  inviteUserIds: [ids.you],
});
await call('you', 'POST', `/api/challenges/${macro.id}/respond`, { accept: true });
const fast = await call<{ id: string }>('you', 'POST', '/api/challenges', {
  name: 'Fast Track',
  metric: 'fast_hours',
  scoring: 'total',
  startDate: d(-3),
  endDate: d(10),
  timezone: TZ,
  inviteUserIds: [ids.dre],
});
await call('dre', 'POST', `/api/challenges/${fast.id}/respond`, { accept: true });

// Two challenges against yourself: a total to reach, and beating your own past week.
await call('you', 'POST', '/api/challenges', {
  name: 'Run 80 km',
  metric: 'distance',
  scoring: 'race_to_goal',
  goal: 80,
  solo: { kind: 'target' },
  startDate: d(-4),
  endDate: d(2),
  timezone: TZ,
});
await call('you', 'POST', '/api/challenges', {
  name: 'Beat last week',
  metric: 'steps',
  scoring: 'daily_avg',
  solo: { kind: 'improve', changePct: 5, direction: 'up', baselineDays: 7 },
  startDate: d(-4),
  endDate: d(3),
  timezone: TZ,
});

// A featured public challenge anyone public can join from Discover.
await call('riley', 'PATCH', '/api/me', { visibility: 'public', handle: 'riley' });
await call('maya', 'PATCH', '/api/me', { visibility: 'public', handle: 'maya' });
const open = await call<{ id: string }>('riley', 'POST', '/api/challenges', {
  name: 'October Step Open',
  metric: 'steps',
  scoring: 'daily_avg',
  startDate: d(-3),
  endDate: d(20),
  timezone: TZ,
  visibility: 'public',
});
await call('riley', 'PATCH', `/api/challenges/${open.id}/featured`, { featured: true });
await call('maya', 'POST', `/api/challenges/${open.id}/join`);

// The API refuses past end dates, so end the old challenge directly.
await ctx.db.execute(sql`update challenges set end_date = ${d(-6)} where id = ${past.id}`);

// Sync everyone, then simulate today's activity so the feed has fresh items.
await runSyncCycle(ctx);
users.maya!.daily.find((r) => r.entry_date === today)!.total_distance_meters! += 10_200;
users.dre!.daily.find((r) => r.entry_date === today)!.total_steps! += 12_000;
users.sam!.daily.find((r) => r.entry_date === today)!.total_distance_meters! += 4_000;
await runSyncCycle(ctx);

const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: '0.0.0.0' });
console.log(`Gauntlet demo API on :${port}. Sign in as you@example.com / demo`);
process.on('SIGTERM', async () => {
  await app.close();
  await client.end();
  process.exit(0);
});
