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
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDays, previousIsoWeek, todayIn, xpToReach, type BadgeDraft } from '@gauntlet/shared';
import { and, eq, sql } from 'drizzle-orm';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { runSyncCycle } from '../src/scheduler.js';
import {
  badgeDefinitions,
  badgeSuggestions,
  dailyMetrics,
  feedEvents,
  healthOrigins,
  serverState,
  userBadges,
  users as usersTable,
} from '../src/db/schema.js';
import { createDraftBadge, publishBadge } from '../src/services/badges/admin.js';
import { recomputeXp } from '../src/services/badges/engine.js';
import { seedBadges } from '../src/services/badges/seed.js';
import { settleBadgeTasks } from '../src/services/badges/tasks.js';
import { refreshDemo } from '../src/services/demo.js';
import { historyTuning } from '../src/services/historyImport.js';
import { notify } from '../src/services/notify.js';
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
        distance: km,
        avg_heart_rate: 138 + (i % 5) * 4,
        start_time: `${date}T07:30:00Z`,
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
// One session with a second lift, so the workout detail has more than one exercise.
users.you!.exerciseEntries.push({
  entry_date: d(-1),
  exercise_name: 'Bench Press',
  exercise_source: 'liftosaur',
  duration_minutes: 0,
  sets: [
    { set_type: 'Warm-up', reps: 8, weight: 40 },
    ...[0, 1, 2].map(() => ({ set_type: 'Working Set', reps: 6, weight: 70 })),
  ],
});
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
// Health Connect readings (private to Alex), for the day screen and Trends.
users.you!.categories.push({
  id: 'cat-hrv',
  name: 'hrv',
  frequency: 'Daily',
  data_type: 'numeric',
});
users.you!.custom['cat-hrv'] = Array.from({ length: 14 }, (_, i) => ({
  date: d(i - 13),
  value: String(44 + ((i * 7) % 13)),
  timestamp: `${d(i - 13)}T06:00:00Z`,
}));
for (let i = 0; i < 14; i++)
  users.you!.daily.push({
    entry_date: d(i - 13),
    source_provider: 'health_connect',
    total_calories: 2400 + i * 20,
  });
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

// A pretend backup service for the admin page (Riley is the admin): two old backups and a heartbeat.
const backupDir = mkdtempSync(join(tmpdir(), 'gauntlet-demo-backups-'));
mkdirSync(join(backupDir, '.status'), { recursive: true });
writeFileSync(join(backupDir, 'gauntlet-backup-20260101-033000.tar'), Buffer.alloc(3_400_000, 1));
writeFileSync(join(backupDir, 'gauntlet-backup-20260102-033000.tar'), Buffer.alloc(3_500_000, 1));
writeFileSync(
  join(backupDir, '.status', 'last-backup.json'),
  JSON.stringify({
    file: 'gauntlet-backup-20260102-033000.tar',
    sizeBytes: 3_500_000,
    createdAt: new Date(Date.now() - 6 * 3600_000).toISOString(),
  }),
);
writeFileSync(
  join(backupDir, '.status', 'schedule.json'),
  JSON.stringify({ nextAt: new Date(Date.now() + 18 * 3600_000).toISOString(), keep: 14 }),
);
const beat = () =>
  writeFileSync(
    join(backupDir, '.status', 'heartbeat.json'),
    JSON.stringify({ at: Math.floor(Date.now() / 1000) }),
  );
beat();
setInterval(beat, 15_000).unref();

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
  BACKUP_DIR: backupDir,
  // The browser tests sign in many times a minute.
  LOGIN_RATE_LIMIT_MAX: '1000',
  // All the browser tests share one address.
  RATE_LIMIT_MAX: '20000',
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

// Test-only hooks for the browser tests (this server is never deployed): give someone a badge,
// as new (so the app celebrates it) or already seen; post a badge to the feed; send a notification.
// Registered now, before the first request makes the app ready.
app.post<{
  Body: { email?: string; key: string; tiers: number; seen?: boolean; level?: number };
}>('/api/_e2e/earn', async (req) => {
  const b = req.body;
  const [u] = await ctx.db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, b.email ?? 'you@example.com'));
  if (!u) throw new Error('no such user');
  await ctx.db
    .delete(userBadges)
    .where(and(eq(userBadges.userId, u.id), eq(userBadges.badgeKey, b.key)));
  await ctx.db.insert(userBadges).values(
    Array.from({ length: b.tiers }, (_, i) => ({
      userId: u.id,
      badgeKey: b.key,
      tier: i + 1,
      earnedAt: new Date(),
      backfilled: false,
      seenAt: b.seen ? new Date() : null,
    })),
  );
  // Put the person just past a level, so a level-up shows (XP is set, not recounted).
  if (b.level)
    await ctx.db
      .update(usersTable)
      .set({ badgeXp: xpToReach(b.level) + 5 })
      .where(eq(usersTable.id, u.id));
  return { ok: true };
});
app.post<{
  Body: {
    email: string;
    name: string;
    tier: number;
    tierName: string | null;
    icon: string;
    more?: number;
  };
}>('/api/_e2e/feed-badge', async (req) => {
  const b = req.body;
  const [u] = await ctx.db.select().from(usersTable).where(eq(usersTable.email, b.email));
  if (!u) throw new Error('no such user');
  await ctx.db.insert(feedEvents).values({
    actorId: u.id,
    challengeId: null,
    kind: 'badge_earned',
    payload: {
      key: 'e2e-feed',
      name: b.name,
      tier: b.tier,
      tierName: b.tierName,
      icon: b.icon,
      imageUrl: null,
      more: b.more ?? 0,
    },
  });
  return { ok: true };
});
// Admin → Accounts: two accounts nobody has used for a long time (one lost its SparkyFitness
// connection), so "expired" has something to show. They cannot sign in; they only exist as rows.
app.post('/api/_e2e/stale-accounts', async () => {
  const day = 86_400_000;
  await ctx.db
    .insert(usersTable)
    .values([
      {
        sparkyUserId: 'e2e-stale-1',
        email: 'taylor@example.com',
        displayName: 'Taylor Quiet',
        createdAt: new Date(Date.now() - 400 * day),
        lastActiveAt: new Date(Date.now() - 200 * day),
        lastSyncedAt: new Date(Date.now() - 200 * day),
      },
      {
        sparkyUserId: 'e2e-stale-2',
        email: 'morgan@example.com',
        displayName: 'Morgan Gone',
        keyStatus: 'invalid',
        createdAt: new Date(Date.now() - 90 * day),
        lastActiveAt: new Date(Date.now() - 45 * day),
      },
    ])
    .onConflictDoNothing();
  return { ok: true };
});
// Admin → Badges → Drafts: a few drafts to publish together.
app.post('/api/_e2e/drafts', async () => {
  for (const [i, name] of ['Early Bird', 'Night Owl', 'Weekend Warrior'].entries()) {
    await createDraftBadge(
      ctx,
      {
        key: `e2e-draft-${i + 1}`,
        name,
        description: 'Walk {n} steps in total.',
        family: 'movement',
        icon: 'rocket',
        imageUrl: null,
        secret: false,
        rule: { type: 'lifetime_total', metric: 'steps', tiers: [40_000_000] },
        window: null,
        xp: null,
        countsManual: true,
      },
      'admin',
    ).catch(() => undefined);
  }
  return { ok: true };
});
// History import: years of older readings (and Garmin linked) for a freshly signed-up account, and
// a pace quick enough for a browser test yet slow enough to watch the progress move.
historyTuning.paceMs = 100;
historyTuning.rateBackoffMs = 0;
app.post<{ Body: { email: string } }>('/api/_e2e/seed-history', async (req) => {
  const u = [...fake.users.values()].find((x) => x.email === req.body.email.toLowerCase());
  if (!u) throw new Error('no such user');
  for (let i = 20; i <= 4 * 365 + 120; i += 6)
    u.daily.push({
      entry_date: d(-i),
      source_provider: 'garmin',
      total_steps: 6000 + (i % 5) * 900,
      total_distance_meters: 4500 + (i % 7) * 600,
    });
  u.daily.push({ entry_date: d(-900), source_provider: 'garmin', total_steps: 41_000 });
  u.garmin = { linkedAt: new Date().toISOString(), syncs: 0 };
  return { ok: true };
});
app.post('/api/_e2e/notify-badge', async () => {
  const [u] = await ctx.db.select().from(usersTable).where(eq(usersTable.email, 'you@example.com'));
  await notify(ctx, u!.id, {
    kind: 'badge',
    title: 'Badge earned',
    body: 'You earned Gold · Show Up',
    url: '/badges',
  });
  return { ok: true };
});

// Re-seed the "where did this come from" detail (see seedStatSources below).
app.post('/api/_e2e/stat-sources', async () => {
  await seedStatSources();
  return { ok: true };
});

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

// A finished challenge with a side bet: Alex beats Dre, so Dre owes the coffee. (Dates are shortened
// below, like Step Wars; the sync cycle then finalizes it.)
const coffee = await call<{ id: string }>('you', 'POST', '/api/challenges', {
  name: 'Coffee Run',
  metric: 'steps',
  scoring: 'total',
  startDate: d(-12),
  endDate: today,
  timezone: TZ,
  inviteUserIds: [ids.dre],
  stake: 'Loser buys coffee',
});
await call('dre', 'POST', `/api/challenges/${coffee.id}/respond`, { accept: true });

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
await call('dre', 'PATCH', '/api/me', {
  settings: { shareEvents: false, shareProfileStats: true },
});
// Sam shares his stats too, so the badge race has more than one friend (Maya keeps hers private).
await call('sam', 'PATCH', '/api/me', { settings: { shareProfileStats: true } });
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
await ctx.db.execute(
  sql`update challenges set end_date = ${d(-6)} where id in (${past.id}, ${coffee.id})`,
);

// Sync everyone, then simulate today's activity so the feed has fresh items.
await runSyncCycle(ctx);
users.maya!.daily.find((r) => r.entry_date === today)!.total_distance_meters! += 10_200;
users.dre!.daily.find((r) => r.entry_date === today)!.total_steps! += 12_000;
users.sam!.daily.find((r) => r.entry_date === today)!.total_distance_meters! += 4_000;
await runSyncCycle(ctx);

// The launch badges, awarded quietly from everyone's history (so nobody is surprised by a
// celebration), and again the demo account's sample set, which needs the definitions to exist.
await seedBadges(ctx);
await settleBadgeTasks();
await refreshDemo(ctx);

// A limited-time badge that is running now (nobody can earn it: 50 million steps), and a few ideas
// from the Garmin badge database waiting under Admin → Badges → Suggested.
const sprint: BadgeDraft = {
  key: 'summer-sprint',
  name: 'Summer Sprint',
  description: 'Walk {n} steps before the season ends.',
  family: 'seasonal',
  icon: 'sun',
  imageUrl: null,
  secret: false,
  rule: { type: 'lifetime_total', metric: 'steps', tiers: [50_000_000] },
  window: { start: d(-5), end: d(9) },
  xp: null,
  countsManual: true,
};
await createDraftBadge(ctx, sprint, 'admin');
await publishBadge(ctx, 'summer-sprint');
await settleBadgeTasks();
// Badges earned over the last three months, so the timeline and the XP race have something to draw.
// The launch backfill dated everyone's badges "today"; spread what they have across ~90 days (higher
// tiers later) and add a few more for the friends who share their stats. All already seen, so
// nobody is greeted by a celebration. Their XP follows the rows, as it does for real earns.
{
  const EXTRA: Record<string, [string, number][]> = {
    you: [
      ['trail-mix', 1],
      ['inner-calm', 1],
    ],
    maya: [
      ['mile-eater', 2],
      ['trail-mix', 2],
      ['habit-forming', 1],
      ['podium-regular', 1],
    ],
    dre: [
      ['mile-eater', 1],
      ['wheelhouse', 2],
      ['inner-calm', 1],
    ],
    sam: [
      ['trail-mix', 1],
      ['wheelhouse', 1],
      ['habit-forming', 1],
    ],
    jordan: [
      ['mile-eater', 1],
      ['inner-calm', 2],
    ],
  };
  const known = new Set(
    (await ctx.db.select({ key: badgeDefinitions.key }).from(badgeDefinitions)).map((x) => x.key),
  );
  const cast = ['you', 'maya', 'dre', 'sam', 'jordan'];
  for (const [pi, who] of cast.entries()) {
    const userId = ids[who]!;
    const mine = await ctx.db.select().from(userBadges).where(eq(userBadges.userId, userId));
    const tiersBy = new Map<string, number>();
    for (const r of mine) tiersBy.set(r.badgeKey, Math.max(tiersBy.get(r.badgeKey) ?? 0, r.tier));
    const fresh: (typeof userBadges.$inferInsert)[] = [];
    for (const [key, tiers] of EXTRA[who] ?? []) {
      if (!known.has(key) || tiersBy.has(key)) continue;
      tiersBy.set(key, tiers);
      for (let t = 1; t <= tiers; t++) fresh.push({ userId, badgeKey: key, tier: t });
    }
    const stamp = (key: string, tier: number, i: number) => {
      const top = tiersBy.get(key) ?? tier;
      const ago = Math.min(89, ((pi * 7 + i * 11) % 80) + 2 + (top - tier) * 9);
      return { at: new Date(`${d(-ago)}T20:00:00Z`), date: d(-ago) };
    };
    const order = [...tiersBy.keys()].sort();
    for (const r of mine) {
      const { at, date } = stamp(r.badgeKey, r.tier, order.indexOf(r.badgeKey));
      await ctx.db
        .update(userBadges)
        .set({ earnedAt: at, context: { date }, backfilled: false, seenAt: new Date() })
        .where(
          and(
            eq(userBadges.userId, userId),
            eq(userBadges.badgeKey, r.badgeKey),
            eq(userBadges.tier, r.tier),
          ),
        );
    }
    if (fresh.length)
      await ctx.db.insert(userBadges).values(
        fresh.map((r) => {
          const { at, date } = stamp(r.badgeKey, r.tier, order.indexOf(r.badgeKey));
          return { ...r, earnedAt: at, context: { date }, backfilled: false, seenAt: new Date() };
        }),
      );
    await recomputeXp(ctx, userId);
  }
}

const idea = (n: number, name: string, description: string) => ({
  sourceRef: String(9000 + n),
  sourceName: name,
  sourceDescription: description,
});
await ctx.db.insert(badgeSuggestions).values([
  {
    ...idea(1, 'Sunrise Mile', 'Complete a run of at least 1 mile before 7 AM.'),
    status: 'matched',
    draft: {
      key: 'first-light',
      name: 'First Light',
      description: 'Finish a {n} km run before 7 am.',
      family: 'consistency',
      icon: 'sunrise',
      imageUrl: null,
      secret: false,
      rule: {
        type: 'single_activity',
        sport: 'run',
        measure: 'distance_km',
        tiers: [2, 5, 10],
        hours: { from: 4, to: 7 },
      },
      window: null,
      xp: null,
      countsManual: true,
    } satisfies BadgeDraft,
  },
  {
    ...idea(2, 'Mountain Goat', 'Climb 1,000 metres in a single activity.'),
    status: 'matched',
    draft: {
      key: 'big-day-out-2',
      name: 'Long Weekend',
      description: 'Log {n} workouts in total.',
      family: 'movement',
      icon: 'mountain',
      imageUrl: null,
      secret: false,
      rule: { type: 'lifetime_total', metric: 'workouts', tiers: [20, 60] },
      window: null,
      xp: null,
      countsManual: true,
    } satisfies BadgeDraft,
  },
  {
    ...idea(3, 'Golf Round', 'Walk a full round of golf.'),
    status: 'skipped',
    reason: 'Gauntlet cannot tell golf from other walks.',
  },
  {
    ...idea(4, 'Pool Party', 'Swim in a pool 10 times.'),
    status: 'failed',
    reason: 'The AI service did not answer. Try again.',
  },
]);
await ctx.db
  .insert(serverState)
  .values({
    key: 'badge_import',
    value: {
      lastRunAt: new Date(Date.now() - 5 * 3600_000).toISOString(),
      lastResult: { fetched: 120, added: 4, matched: 2, skipped: 1, failed: 1, error: null },
      running: false,
    },
  })
  .onConflictDoNothing();

// Alex's notifications: the sync cycles above may have produced some (it depends on the day of the
// week), so start from a known inbox. Three unread, one read; the oldest is what the bell shows last.
await ctx.db.execute(sql`delete from notifications`);
const inbox = async (
  kind: 'nudge' | 'weekly_recap' | 'lead_change' | 'friend_request',
  title: string,
  body: string,
  url: string,
) => notify(ctx, ids.you!, { kind, title, body, url });
const nudge = await inbox(
  'nudge',
  'Dre nudged you',
  'Dre is waiting on your steps in Weekend 100K.',
  `/c/${live.id}`,
);
await ctx.db.execute(sql`update notifications set read_at = now() where id = ${nudge!.id}`);
await inbox(
  'weekly_recap',
  'Your week in review',
  'Last week: 71k steps (+12%), 3 workouts.',
  `/recap/${previousIsoWeek(today)}`,
);
await inbox(
  'lead_change',
  'You lost the lead',
  'Maya just took the lead in Weekend 100K.',
  `/c/${live.id}`,
);
await inbox('friend_request', 'New friend request', 'Riley P. wants to be friends.', '/friends');

// "Where did this come from": Alex's steps today were counted from Health Connect (highest of two
// sources), with Fitbit and Samsung Health both writing steps on the phone; sleep follows Alex's
// source order for it. Resting heart rate is left without detail, like a value stored before 0.17.
// Runs now and again from the e2e hook, because a sync rewrites the values (not this detail).
async function seedStatSources() {
  const uid = ids.you!;
  const at = (metric: string, date: string) =>
    and(eq(dailyMetrics.userId, uid), eq(dailyMetrics.date, date), eq(dailyMetrics.metric, metric));
  const steps = (await ctx.db.select().from(dailyMetrics).where(at('steps', today)))[0]?.value;
  if (steps != null) {
    await ctx.db
      .update(dailyMetrics)
      .set({
        source: 'Health Connect',
        detail: {
          rule: 'highest',
          candidates: [
            { source: 'Health Connect', value: steps },
            { source: 'garmin', value: Math.round(steps * 0.86) },
          ],
        },
      })
      .where(at('steps', today));
  }
  const sleep = (await ctx.db.select().from(dailyMetrics).where(at('sleep', today)))[0]?.value;
  if (sleep != null) {
    await ctx.db
      .update(dailyMetrics)
      .set({
        source: 'garmin',
        detail: {
          rule: 'priority',
          order: 'metric',
          candidates: [
            { source: 'garmin', value: sleep },
            { source: 'Health Connect', value: Math.round((sleep - 0.4) * 10) / 10 },
          ],
        },
      })
      .where(at('sleep', today));
  }
  const origins = [];
  if (steps != null)
    origins.push({
      userId: uid,
      date: today,
      metric: 'steps',
      apps: [
        {
          packageName: 'com.fitbit.FitbitMobile',
          value: steps,
          records: 148,
          devices: ['watch'],
        },
        {
          packageName: 'com.sec.android.app.shealth',
          value: Math.round(steps * 0.62),
          records: 64,
          devices: ['phone'],
        },
      ],
      counted: steps,
      capped: false,
    });
  if (sleep != null)
    origins.push({
      userId: uid,
      date: today,
      metric: 'sleep',
      apps: [
        {
          packageName: 'com.garmin.android.apps.connectmobile',
          value: sleep,
          records: 3,
          devices: ['watch'],
        },
      ],
      counted: sleep,
      capped: false,
    });
  await ctx.db
    .delete(healthOrigins)
    .where(and(eq(healthOrigins.userId, uid), eq(healthOrigins.date, today)));
  if (origins.length) await ctx.db.insert(healthOrigins).values(origins);
}
await seedStatSources();

const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: '0.0.0.0' });
console.log(`Gauntlet demo API on :${port}. Sign in as you@example.com / demo`);
process.on('SIGTERM', async () => {
  await app.close();
  await client.end();
  process.exit(0);
});
