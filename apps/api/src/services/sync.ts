/**
 * Pulls a user's recent health data from SparkyFitness, normalises it into
 * daily_metrics, and updates the challenges that user is in.
 */
import {
  addDays,
  BUILTIN_METRICS,
  isCustomMetric,
  minDate,
  todayIn,
  type MetricAggregate,
} from '@gauntlet/shared';
import { and, eq, gte, lte } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { dailyMetrics, feedEvents, users } from '../db/schema.js';
import { SparkyError, type CustomMeasurementRow } from '../sparky/client.js';
import { mergeDaily, wantedCategoryNames, type MergedValue } from '../sparky/merge.js';
import { openChallengesForUser, refreshChallenge, type ChallengeRow } from './challenges.js';
import { getUser, markKeyInvalid, sparkyToken } from './users.js';

/** How far back the Today and Trends screens look. */
const HISTORY_DAYS = 62;
/** Never pull more than this many days in one go. */
const MAX_WINDOW_DAYS = 120;

/** Smallest change worth a feed post, per metric. */
const PROGRESS_THRESHOLD: Record<string, number> = {
  steps: 2000,
  distance: 1,
  active_minutes: 15,
  active_calories: 150,
  workouts: 1,
};

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
export function syncUser(ctx: AppContext, userId: string): Promise<SyncResult> {
  const running = inFlight.get(userId);
  if (running) {
    const existing = queued.get(userId);
    if (existing) return existing;
    const next = running
      .catch(() => undefined)
      .then(() => {
        queued.delete(userId);
        return syncUser(ctx, userId);
      });
    queued.set(userId, next);
    return next;
  }
  const p = doSync(ctx, userId).finally(() => inFlight.delete(userId));
  inFlight.set(userId, p);
  return p;
}

async function doSync(ctx: AppContext, userId: string): Promise<SyncResult> {
  const user = await getUser(ctx, userId);
  if (user.keyStatus !== 'active' || !user.sparkyKeyEnc)
    return { userId, ok: false, changed: 0, error: 'sparky_key_invalid' };
  const token = sparkyToken(ctx, user);
  const open = await openChallengesForUser(ctx, userId);

  // Window: recent history plus the start of any challenge still running.
  // End one day ahead of UTC so users east of UTC get "today" too.
  const end = addDays(todayIn('UTC', ctx.now()), 1);
  let start = addDays(todayIn(user.timezone, ctx.now()), -HISTORY_DAYS);
  for (const ch of open) start = minDate(start, ch.startDate);
  start = start < addDays(end, -MAX_WINDOW_DAYS) ? addDays(end, -MAX_WINDOW_DAYS) : start;

  const customMetrics: Record<string, MetricAggregate> = {};
  for (const ch of open) {
    if (isCustomMetric(ch.metric))
      customMetrics[ch.metric.slice('custom:'.length).toLowerCase()] = ch.aggregate;
  }

  let merged: MergedValue[];
  let partial: boolean;
  try {
    ({ merged, partial } = await fetchAndMerge(ctx, token, start, end, customMetrics));
  } catch (err) {
    if (err instanceof SparkyError && err.status === 401) {
      await markKeyInvalid(ctx, userId);
      return { userId, ok: false, changed: 0, error: 'sparky_key_invalid' };
    }
    ctx.log.warn({ err, userId }, 'sync failed');
    return { userId, ok: false, changed: 0, error: (err as Error).message };
  }

  const changes = await store(ctx, userId, start, end, merged, Object.keys(customMetrics), partial);
  await ctx.db.update(users).set({ lastSyncedAt: ctx.now() }).where(eq(users.id, userId));

  // First sync pulls weeks of history at once; don't post that as "progress".
  if (user.lastSyncedAt) await postProgress(ctx, userId, open, changes);
  for (const ch of open) await refreshChallenge(ctx, ch);
  return { userId, ok: true, changed: changes.length };
}

async function fetchAndMerge(
  ctx: AppContext,
  token: string,
  start: string,
  end: string,
  customMetrics: Record<string, MetricAggregate>,
): Promise<{ merged: MergedValue[]; partial: boolean }> {
  const s = ctx.sparky;
  let partial = false;
  // Fail fast on a revoked key before fanning out.
  const categories = await s.customCategories(token);

  const settle = async <T>(label: string, p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch (err) {
      if (err instanceof SparkyError && err.status === 401) throw err;
      ctx.log.warn(
        { err: (err as Error).message, label },
        'sparky read failed; continuing without it',
      );
      partial = true;
      return fallback;
    }
  };

  const wanted = new Set(wantedCategoryNames(customMetrics));
  const matched = categories.filter((c) => wanted.has(c.name.toLowerCase()));
  const [daily, checkIns, exerciseDays, exerciseEntries, sleep, customRows] = await Promise.all([
    settle('daily', s.dailyHealthMetrics(token, start, end), []),
    settle('checkins', s.checkIns(token, start, end), []),
    settle('exercise-days', s.exerciseDays(token, start, end), []),
    settle('exercise-entries', s.exerciseEntries(token, start, end), []),
    settle('sleep', s.sleep(token, start, end), []),
    Promise.all(
      matched.map(
        async (c) =>
          [
            c,
            await settle(
              `custom:${c.name}`,
              s.customMeasurements(token, c.id, start, end),
              [] as CustomMeasurementRow[],
            ),
          ] as const,
      ),
    ),
  ]);

  const custom: Parameters<typeof mergeDaily>[0]['custom'] = {};
  for (const [category, rows] of customRows) {
    const key = category.name.toLowerCase();
    const existing = custom[key];
    custom[key] = existing ? { category, rows: [...existing.rows, ...rows] } : { category, rows };
  }
  return {
    merged: mergeDaily({
      start,
      end,
      daily,
      checkIns,
      custom,
      exerciseDays,
      exerciseEntries,
      sleep,
      customMetrics,
    }),
    partial,
  };
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
  customNames: string[],
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
  const managed = new Set<string>([...BUILTIN_METRICS, ...customNames.map((n) => `custom:${n}`)]);

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
    : existing.filter((r) => managed.has(r.metric) && !seen.has(`${r.date}|${r.metric}`));

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
    if (posted.has(ch.metric)) continue;
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
