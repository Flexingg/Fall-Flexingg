import { addDays, metricDef, soloScoring, todayIn, type MetricKey } from '@gauntlet/shared';
import type { SoloConfig } from '@gauntlet/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import {
  badgeDefinitions,
  challengeParticipants,
  challenges,
  dailyMetrics,
  feedEvents,
  friendships,
  userBadges,
  users,
} from '../db/schema.js';
import { recomputeXp } from './badges/engine.js';
import { finalizeChallenge, refreshChallenge } from './challenges.js';
import type { UserRow } from './users.js';

/**
 * The built-in demo account: someone to sign in as without a SparkyFitness account (app store
 * reviewers, curious visitors). It has a cast of made-up friends, sample stats and a few challenges,
 * all rebuilt every day so "this week" always looks live. It has no SparkyFitness behind it, so the
 * things that need one (linking apps, fasting, Health Connect) are switched off for it.
 */
export const DEMO_ID = 'demo:you';
const LOCK_ID = 7_340_113;

interface Persona {
  key: string;
  name: string;
  /** Typical daily steps, and how much they lift / train. */
  steps: number;
  trains: number;
  lifts: number;
}

const ME: Persona = { key: 'you', name: 'Demo Athlete', steps: 9800, trains: 0.55, lifts: 0.4 };
const CAST: Persona[] = [
  { key: 'maya', name: 'Maya Rodriguez', steps: 12400, trains: 0.7, lifts: 0.3 },
  { key: 'dre', name: 'Dre Walker', steps: 8700, trains: 0.6, lifts: 0.7 },
  { key: 'sam', name: 'Sam Okafor', steps: 10900, trains: 0.45, lifts: 0.2 },
  { key: 'priya', name: 'Priya Nair', steps: 7600, trains: 0.5, lifts: 0.5 },
  { key: 'leo', name: 'Leo Fischer', steps: 11300, trains: 0.35, lifts: 0.4 },
];

/** Same inputs, same number: a tiny seeded random generator (mulberry32). */
function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dayRows(userId: string, p: Persona, date: string, partial: boolean) {
  const r = rng(`${p.key}|${date}`);
  const weekend = [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
  const scale = partial ? 0.55 : 1;
  const steps = Math.round(p.steps * (0.55 + r() * 0.9) * (weekend ? 0.9 : 1) * scale);
  const trained = r() < p.trains;
  const lifted = r() < p.lifts;
  const vals: Partial<Record<MetricKey, number>> = {
    steps,
    distance: Math.round(steps * 0.00072 * 100) / 100,
    active_calories: Math.round(
      steps * 0.04 + (trained ? 280 + r() * 220 : 0) + (lifted ? 150 : 0),
    ),
    active_minutes: Math.round(steps / 160 + (trained ? 35 : 0)),
    workouts: trained || lifted ? 1 : 0,
    resting_hr: Math.round(52 + r() * 10),
    sleep: Math.round((6.2 + r() * 2.2) * 10) / 10,
  };
  if (lifted) {
    const sets = 12 + Math.floor(r() * 10);
    vals.lift_sets = sets;
    vals.lift_volume = Math.round(sets * (260 + r() * 260));
  }
  if (partial) {
    delete vals.sleep;
    delete vals.resting_hr;
  }
  return Object.entries(vals).map(([metric, value]) => ({
    userId,
    date,
    metric,
    value: value as number,
    source: 'Demo',
  }));
}

/**
 * The demo account never earns badges live; it shows this fixed sample instead (key, tier reached),
 * so the badge screens have something to draw. Keys that don't exist (yet) are skipped.
 */
const DEMO_BADGES: Record<string, [string, number][]> = {
  you: [
    ['long-haul', 2],
    ['far-out', 1],
    ['show-up', 2],
    ['big-day-out', 1],
    ['never-miss', 1],
    ['habit-forming', 2],
    ['victory-lap', 1],
    ['biggest-fan', 2],
    ['iron-tonnage', 1],
    ['early-bird', 1],
  ],
  maya: [
    ['long-haul', 3],
    ['far-out', 2],
    ['show-up', 3],
    ['never-miss', 2],
    ['victory-lap', 2],
    ['pavement-poet', 3],
  ],
  dre: [
    ['iron-tonnage', 3],
    ['gym-rat', 2],
    ['show-up', 2],
    ['record-breaker', 2],
  ],
  sam: [
    ['long-haul', 2],
    ['biggest-fan', 1],
  ],
};

async function seedDemoBadges(ctx: AppContext, people: [string, UserRow][]) {
  const ids = people.map(([, u]) => u.id);
  await ctx.db.delete(userBadges).where(inArray(userBadges.userId, ids));
  const wanted = new Set(Object.values(DEMO_BADGES).flatMap((l) => l.map(([k]) => k)));
  const known = new Set(
    (await ctx.db.select({ key: badgeDefinitions.key }).from(badgeDefinitions)).map((d) => d.key),
  );
  const rows = people.flatMap(([key, u]) =>
    (DEMO_BADGES[key] ?? []).flatMap(([badge, tiers], i) =>
      wanted.has(badge) && known.has(badge)
        ? Array.from({ length: tiers }, (_, t) => ({
            userId: u.id,
            badgeKey: badge,
            tier: t + 1,
            earnedAt: new Date(ctx.now().getTime() - (i * 3 + (tiers - t) * 2 + 1) * 86_400_000),
            backfilled: false,
            seenAt: ctx.now(),
          }))
        : [],
    ),
  );
  if (rows.length) await ctx.db.insert(userBadges).values(rows);
  for (const id of ids) await recomputeXp(ctx, id);
}

async function upsertPerson(ctx: AppContext, p: Persona): Promise<UserRow> {
  const sparkyUserId = `demo:${p.key}`;
  const email = `${p.key}@demo.gauntlet.invalid`;
  const [row] = await ctx.db
    .insert(users)
    .values({
      sparkyUserId,
      email,
      displayName: p.name,
      timezone: 'UTC',
      isDemo: true,
      visibility: 'private',
    })
    .onConflictDoUpdate({
      target: users.sparkyUserId,
      set: { displayName: p.name, isDemo: true, keyStatus: 'active', visibility: 'private' },
    })
    .returning();
  return row!;
}

/**
 * Make sure the demo cast exists and is fresh: a window of daily stats ending today, friendships,
 * and a handful of challenges dated around today. Safe to call any time (it's a full reset of
 * what's demo-owned; real users' data is never touched).
 */
export async function refreshDemo(ctx: AppContext): Promise<void> {
  if (!ctx.cfg.DEMO_ACCOUNT) return;
  await ctx.db.transaction(async (tx) => {
    const [lock] = await tx.execute<{ ok: boolean }>(
      sql`select pg_try_advisory_xact_lock(${LOCK_ID}) as ok`,
    );
    if (!lock?.ok) return;
    const t: AppContext = { ...ctx, db: tx as unknown as AppContext['db'] };
    await seed(t);
  });
  lastRefreshedOn = todayIn('UTC', ctx.now());
  // Settle standings and results once the rows are committed.
  const demoIds = await ctx.db.select({ id: users.id }).from(users).where(eq(users.isDemo, true));
  const rows = demoIds.length
    ? await ctx.db
        .select()
        .from(challenges)
        .where(
          inArray(
            challenges.createdBy,
            demoIds.map((d) => d.id),
          ),
        )
    : [];
  for (const ch of rows) {
    await refreshChallenge(ctx, ch.id);
    await finalizeChallenge(ctx, ch);
  }
}

async function seed(ctx: AppContext): Promise<void> {
  const today = todayIn('UTC', ctx.now());
  const me = await upsertPerson(ctx, ME);
  const friends = await Promise.all(CAST.map((p) => upsertPerson(ctx, p)));
  const everyone = [me, ...friends];
  const personas = [ME, ...CAST];
  const ids = everyone.map((u) => u.id);

  // Anything built on a previous day (or by someone playing with the demo) goes.
  await ctx.db.delete(challenges).where(inArray(challenges.createdBy, ids));
  await ctx.db.delete(feedEvents).where(inArray(feedEvents.actorId, ids));
  await ctx.db.delete(dailyMetrics).where(inArray(dailyMetrics.userId, ids));
  await ctx.db.delete(friendships).where(inArray(friendships.userLow, ids));

  await seedDemoBadges(ctx, [
    ['you', me],
    ...friends.map((u, i): [string, UserRow] => [CAST[i]!.key, u]),
  ]);

  // 70 days of stats, ending with a part-way-through today.
  const rows = everyone.flatMap((u, i) => {
    const out = [];
    for (let d = 70; d >= 0; d--)
      out.push(...dayRows(u.id, personas[i]!, addDays(today, -d), d === 0));
    return out;
  });
  for (let i = 0; i < rows.length; i += 1000)
    await ctx.db.insert(dailyMetrics).values(rows.slice(i, i + 1000));

  // Everyone is friends with the demo account (and each other).
  const pairs: { low: string; high: string }[] = [];
  for (let a = 0; a < ids.length; a++)
    for (let b = a + 1; b < ids.length; b++) {
      const [low, high] = ids[a]! < ids[b]! ? [ids[a]!, ids[b]!] : [ids[b]!, ids[a]!];
      pairs.push({ low, high });
    }
  await ctx.db.insert(friendships).values(
    pairs.map((p) => ({
      userLow: p.low,
      userHigh: p.high,
      requestedBy: me.id,
      status: 'accepted' as const,
      acceptedAt: ctx.now(),
    })),
  );

  const make = async (
    name: string,
    metric: MetricKey,
    scoring: 'total' | 'race_to_goal' | 'daily_avg' | 'best_day' | 'streak',
    start: number,
    end: number,
    creator: UserRow,
    members: UserRow[],
    opts: { goal?: number; solo?: SoloConfig; showEvents?: boolean } = {},
  ) => {
    const def = metricDef(metric);
    const [ch] = await ctx.db
      .insert(challenges)
      .values({
        name,
        metric,
        aggregate: def.aggregate,
        lowerIsBetter: def.lowerIsBetter,
        scoring,
        goal: opts.goal ?? null,
        solo: opts.solo ?? null,
        startDate: addDays(today, start),
        endDate: addDays(today, end),
        timezone: 'UTC',
        createdBy: creator.id,
        showEvents: opts.showEvents ?? false,
      })
      .returning();
    await ctx.db
      .insert(challengeParticipants)
      .values(
        members.map((u) => ({ challengeId: ch!.id, userId: u.id, state: 'joined' as const })),
      );
    if (!opts.solo)
      await ctx.db.insert(feedEvents).values({
        actorId: creator.id,
        challengeId: ch!.id,
        kind: 'challenge_created',
        payload: {},
      });
  };

  const [maya, dre] = friends as [UserRow, UserRow];
  await make('Steps this week', 'steps', 'total', -3, 3, maya, everyone);
  await make('Burn 8,000 kcal', 'active_calories', 'race_to_goal', -5, 9, me, [me, maya, dre], {
    goal: 8000,
  });
  await make('Lift more than Dre', 'lift_volume', 'total', -4, 10, dre, [me, dre, friends[3]!], {
    showEvents: true,
  });
  await make('Last week: most steps', 'steps', 'total', -12, -6, dre, everyone);
  await make('Run 80 km', 'distance', soloScoring('target'), -9, 12, me, [me], {
    goal: 80,
    solo: { kind: 'target' },
  });
  await make('Beat my last 30 days', 'steps', soloScoring('improve'), -10, 18, me, [me], {
    solo: { kind: 'improve', changePct: 10, direction: 'up', baselineDays: 30 },
  });
}

/** Called by the scheduler: rebuild once per day. */
let lastRefreshedOn = '';
export async function maintainDemo(ctx: AppContext): Promise<void> {
  if (!ctx.cfg.DEMO_ACCOUNT) return;
  const today = todayIn('UTC', ctx.now());
  if (lastRefreshedOn === today) return;
  lastRefreshedOn = today;
  await refreshDemo(ctx);
}

export async function findDemoUser(ctx: AppContext): Promise<UserRow | null> {
  const [u] = await ctx.db.select().from(users).where(eq(users.sparkyUserId, DEMO_ID));
  return u ?? null;
}
