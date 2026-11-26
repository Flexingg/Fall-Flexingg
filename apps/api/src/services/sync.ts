/**
 * Pulls a user's recent health data from SparkyFitness, normalises it into
 * daily_metrics, and updates the challenges that user is in.
 */
import {
  addDays,
  BUILTIN_METRICS,
  HIDDEN_METRICS,
  isCustomMetric,
  isLiftMetric,
  liftExercise,
  minDate,
  todayIn,
  type MetricAggregate,
} from '@gauntlet/shared';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { dailyMetrics, feedEvents, users } from '../db/schema.js';
import { fetchMerged, SparkyError, type GoalsRow, type MergedValue } from '@gauntlet/sparky';
import { openChallengesForUser, refreshChallenge, type ChallengeRow } from './challenges.js';
import { getUser, markKeyInvalid, sparkyToken } from './users.js';

/** How far back the Today and Trends screens look. */
const HISTORY_DAYS = 62;
/** Never pull more than this many days in one go. */
const MAX_WINDOW_DAYS = 400;

/** Smallest change worth a feed post, per metric. */
const PROGRESS_THRESHOLD: Record<string, number> = {
  steps: 2000,
  distance: 1,
  active_minutes: 15,
  active_calories: 150,
  workouts: 1,
  lift_volume: 2000,
  lift_sets: 10,
  water: 1,
  fast_hours: 12,
  fasts_completed: 1,
};

const GOAL_ROWS = ['goal_calories', 'goal_protein', 'goal_carbs', 'goal_fat', 'goal_water'];
/** Goals can still change for recent days, so these are always looked up again. */
const GOALS_SETTLED_AFTER_DAYS = 2;

export interface SyncResult {
  userId: string;
  ok: boolean;
  changed: number;
  error?: string;
}

const inFlight = new Map<string, Promise<SyncResult>>();
const queued = new Map<string, Promise<SyncResult>>();

/**
 * Sync one user. A call made while a sync is running waits for it and then
 * runs once more, so it always sees data written before the call; any further
 * callers share that queued run.
 */
export interface SyncOptions {
  /**
   * Re-rank the user's challenges when done (default). The background cycle turns this off and
   * settles every challenge once all syncs are in, so a leader isn't announced and then
   * overtaken just because of the order people happened to sync in.
   */
  settle?: boolean;
}

export function syncUser(
  ctx: AppContext,
  userId: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const running = inFlight.get(userId);
  if (running) {
    const existing = queued.get(userId);
    if (existing) return existing;
    const next = running
      .catch(() => undefined)
      .then(() => {
        queued.delete(userId);
        return syncUser(ctx, userId, opts);
      });
    queued.set(userId, next);
    return next;
  }
  const p = doSync(ctx, userId, opts).finally(() => inFlight.delete(userId));
  inFlight.set(userId, p);
  return p;
}

async function doSync(ctx: AppContext, userId: string, opts: SyncOptions): Promise<SyncResult> {
  const user = await getUser(ctx, userId);
  if (user.isDemo) return { userId, ok: true, changed: 0 };
  if (user.keyStatus !== 'active' || !user.sparkyKeyEnc)
    return failSync(ctx, userId, 'sparky_key_invalid', 'SparkyFitness key is not valid');
  const token = sparkyToken(ctx, user);
  const open = await openChallengesForUser(ctx, userId);

  // Window: recent history plus the start of any challenge still running.
  // End one day ahead of UTC so users east of UTC get "today" too.
  const end = addDays(todayIn('UTC', ctx.now()), 1);
  let start = addDays(todayIn(user.timezone, ctx.now()), -HISTORY_DAYS);
  for (const ch of open) {
    start = minDate(start, ch.startDate);
    // "Beat my past self" compares with the days before it started.
    if (ch.solo?.kind === 'improve')
      start = minDate(start, addDays(ch.startDate, -ch.solo.baselineDays));
  }
  start = start < addDays(end, -MAX_WINDOW_DAYS) ? addDays(end, -MAX_WINDOW_DAYS) : start;

  const customMetrics: Record<string, MetricAggregate> = {};
  const lifts = new Set<string>();
  for (const ch of open) {
    if (isCustomMetric(ch.metric))
      customMetrics[ch.metric.slice('custom:'.length).toLowerCase()] = ch.aggregate;
    const lift = liftExercise(ch.metric);
    if (lift) lifts.add(lift.exercise);
  }
  // Goals are read for every day with food or water logged (it is one call each, only for days that
  // have something, and settled days are remembered), so adherence is on Trends as well as in challenges.
  const knownGoals = await storedGoals(
    ctx,
    userId,
    start,
    addDays(todayIn(user.timezone, ctx.now()), -GOALS_SETTLED_AFTER_DAYS),
  );

  let merged: MergedValue[];
  let partial: boolean;
  let sources: Record<string, string[]>;
  try {
    ({ merged, partial, sources } = await fetchMerged(ctx.sparky, token, start, end, {
      customMetrics,
      lifts: [...lifts],
      timezone: user.timezone,
      goals: { known: knownGoals },
      // Everything a challenge can be scored on is also kept for the Trends screen.
      allCustom: true,
      allLifts: true,
      onSkip: (label, err) =>
        ctx.log.warn({ err: err.message, label }, 'sparky read failed; continuing without it'),
      priorities: user.sourcePriorities,
    }));
  } catch (err) {
    if (err instanceof SparkyError && err.status === 401) {
      await markKeyInvalid(ctx, userId);
      return failSync(ctx, userId, 'sparky_key_invalid', 'SparkyFitness key is not valid');
    }
    ctx.log.warn({ err, userId }, 'sync failed');
    return failSync(ctx, userId, (err as Error).message);
  }

  // Metrics this sync is responsible for: a value it no longer sees was deleted in SparkyFitness.
  const managed = new Set<string>([
    ...BUILTIN_METRICS,
    ...HIDDEN_METRICS,
    ...Object.keys(customMetrics).map((n) => `custom:${n}`),
    ...[...lifts].flatMap((l) => [`lift_max:${l}`, `lift_e1rm:${l}`]),
  ]);
  const isManaged = (m: string) => managed.has(m) || m.startsWith('custom:') || isLiftMetric(m);
  const changes = await store(ctx, userId, start, end, merged, isManaged, partial);
  await ctx.db
    .update(users)
    .set({
      lastSyncedAt: ctx.now(),
      seenSources: sources,
      lastSyncError: null,
      lastSyncErrorAt: null,
    })
    .where(eq(users.id, userId));

  // First sync pulls weeks of history at once; don't post that as "progress".
  if (user.lastSyncedAt) await postProgress(ctx, userId, open, changes);
  if (opts.settle !== false) for (const ch of open) await refreshChallenge(ctx, ch.id);
  return { userId, ok: true, changed: changes.length };
}

/** Remember why a sync failed, so the admin page can show it. */
async function failSync(
  ctx: AppContext,
  userId: string,
  error: string,
  shown = error,
): Promise<SyncResult> {
  await ctx.db
    .update(users)
    .set({ lastSyncError: shown.slice(0, 300), lastSyncErrorAt: ctx.now() })
    .where(eq(users.id, userId))
    .catch(() => undefined);
  return { userId, ok: false, changed: 0, error };
}

/** Goals already stored for settled days, so they aren't looked up again. */
async function storedGoals(
  ctx: AppContext,
  userId: string,
  start: string,
  before: string,
): Promise<Record<string, GoalsRow>> {
  const rows = await ctx.db
    .select()
    .from(dailyMetrics)
    .where(
      and(
        eq(dailyMetrics.userId, userId),
        gte(dailyMetrics.date, start),
        lte(dailyMetrics.date, before),
        inArray(dailyMetrics.metric, GOAL_ROWS),
      ),
    );
  const out: Record<string, GoalsRow> = {};
  for (const r of rows) {
    const g = (out[r.date] ??= {});
    if (r.metric === 'goal_calories') g.calories = r.value;
    if (r.metric === 'goal_protein') g.protein = r.value;
    if (r.metric === 'goal_carbs') g.carbs = r.value;
    if (r.metric === 'goal_fat') g.fat = r.value;
    if (r.metric === 'goal_water') g.water_goal_ml = r.value * 1000;
  }
  return out;
}

interface Change {
  date: string;
  metric: string;
  before: number;
  after: number;
  source: string | null;
}

/** Upsert merged values and drop values SparkyFitness no longer has. Returns what changed. */
async function store(
  ctx: AppContext,
  userId: string,
  start: string,
  end: string,
  merged: MergedValue[],
  isManaged: (metric: string) => boolean,
  /** A source failed to load: keep existing values rather than treating them as deleted. */
  partial: boolean,
): Promise<Change[]> {
  const existing = await ctx.db
    .select()
    .from(dailyMetrics)
    .where(
      and(
        eq(dailyMetrics.userId, userId),
        gte(dailyMetrics.date, start),
        lte(dailyMetrics.date, end),
      ),
    );
  const before = new Map(existing.map((r) => [`${r.date}|${r.metric}`, r.value]));

  const changes: Change[] = [];
  const seen = new Set<string>();
  for (const m of merged) {
    const k = `${m.date}|${m.metric}`;
    seen.add(k);
    const prev = before.get(k);
    if (prev === m.value) continue;
    changes.push({
      date: m.date,
      metric: m.metric,
      before: prev ?? 0,
      after: m.value,
      source: m.source,
    });
  }
  const removed = partial
    ? []
    : existing.filter((r) => isManaged(r.metric) && !seen.has(`${r.date}|${r.metric}`));

  await ctx.db.transaction(async (tx) => {
    for (const c of changes) {
      const m = merged.find((x) => x.date === c.date && x.metric === c.metric)!;
      await tx
        .insert(dailyMetrics)
        .values({
          userId,
          date: m.date,
          metric: m.metric,
          value: m.value,
          source: m.source,
          updatedAt: ctx.now(),
        })
        .onConflictDoUpdate({
          target: [dailyMetrics.userId, dailyMetrics.date, dailyMetrics.metric],
          set: { value: m.value, source: m.source, updatedAt: ctx.now() },
        });
    }
    for (const r of removed) {
      await tx
        .delete(dailyMetrics)
        .where(
          and(
            eq(dailyMetrics.userId, userId),
            eq(dailyMetrics.date, r.date),
            eq(dailyMetrics.metric, r.metric),
          ),
        );
      changes.push({ date: r.date, metric: r.metric, before: r.value, after: 0, source: null });
    }
  });
  return changes;
}

/** Post a feed item when someone makes a meaningful jump in a metric they're competing on. */
async function postProgress(
  ctx: AppContext,
  userId: string,
  open: ChallengeRow[],
  changes: Change[],
) {
  const posted = new Set<string>();
  for (const ch of open) {
    // A solo challenge has no one to tell.
    if (ch.solo || posted.has(ch.metric)) continue;
    const relevant = changes.filter(
      (c) => c.metric === ch.metric && c.date >= ch.startDate && c.date <= ch.endDate,
    );
    const delta = relevant.reduce((sum, c) => sum + (c.after - c.before), 0);
    const threshold = PROGRESS_THRESHOLD[ch.metric] ?? (isCustomMetric(ch.metric) ? 0 : Infinity);
    if (!(delta > 0 && delta >= threshold)) continue;
    posted.add(ch.metric);
    const source = relevant.find((c) => c.source)?.source ?? null;
    await ctx.db.insert(feedEvents).values({
      actorId: userId,
      challengeId: ch.id,
      kind: 'progress',
      payload: { metric: ch.metric, delta: Math.round(delta * 100) / 100, source },
    });
  }
}
