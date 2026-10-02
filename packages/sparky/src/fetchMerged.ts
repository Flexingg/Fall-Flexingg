import { addDays, isMetricKey, type ChallengeEvent, type MetricAggregate } from '@gauntlet/shared';
import type { CustomMeasurementRow, GoalsRow, SparkyClient } from './client.js';
import { SparkyError } from './client.js';
import {
  buildEvents,
  DISTANCE_CATEGORIES,
  liftOptions,
  mergeDaily,
  RESTING_HR_CATEGORIES,
  wantedCategoryNames,
  type MergedValue,
  type MergeInput,
} from './merge.js';

/**
 * Read everything Gauntlet scores from SparkyFitness for a date range and merge it into one value
 * per day and metric. Used by the API and by the Android app's direct mode, so both agree.
 *
 * A source that fails is skipped (reported through `onSkip`, and `partial` is set) so one flaky
 * endpoint doesn't blank the whole app. A rejected key (401) always throws.
 */
export interface FetchOptions {
  /** Custom metrics wanted by the user's challenges: name (lower case) -> aggregate. */
  customMetrics?: Record<string, MetricAggregate>;
  /** Exercises (lower case) wanted for per-exercise strength metrics. */
  lifts?: string[];
  /** The person's time zone (fasts count on the day they end). */
  timezone?: string;
  /**
   * Read the person's goals for days with food or water logged (one call per day), for adherence
   * metrics. `known` holds goals already stored, which aren't fetched again.
   */
  goals?: { known?: Record<string, GoalsRow>; maxFetches?: number };
  /**
   * Also read the person's other numeric custom measurements (up to a handful), as daily averages,
   * so they can be charted on Trends. Challenge metrics keep their own aggregate.
   */
  allCustom?: boolean;
  /** Track the heaviest set and estimated 1RM of every exercise with weighted sets (most trained first). */
  allLifts?: boolean;
  onSkip?: (label: string, err: Error) => void;
}

/** At most this many goal look-ups per sync; the rest come on later syncs. */
const MAX_GOAL_FETCHES = 40;
/** Custom measurements and exercises tracked beyond what challenges ask for. */
const MAX_EXTRA_CUSTOM = 8;
const MAX_LIFTS = 30;

export async function fetchMerged(
  sparky: SparkyClient,
  token: string,
  start: string,
  end: string,
  opts: FetchOptions = {},
): Promise<{ merged: MergedValue[]; partial: boolean }> {
  const customMetrics = opts.customMetrics ?? {};
  const onSkip = opts.onSkip ?? (() => {});
  let partial = false;
  // Fail fast on a revoked key before fanning out.
  const categories = await sparky.customCategories(token);

  const settle = async <T>(label: string, p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch (err) {
      if (err instanceof SparkyError && err.status === 401) throw err;
      onSkip(label, err as Error);
      partial = true;
      return fallback;
    }
  };

  const wanted = new Set(wantedCategoryNames(customMetrics));
  // Other numeric categories, for Trends only: never the ones built-in metrics already read.
  const builtin = new Set([...DISTANCE_CATEGORIES, ...RESTING_HR_CATEGORIES]);
  const extra = opts.allCustom
    ? categories
        .filter(
          (c) =>
            (c.data_type ?? 'numeric') === 'numeric' &&
            !wanted.has(c.name.toLowerCase()) &&
            !builtin.has(c.name.toLowerCase()) &&
            isMetricKey(`custom:${c.name.toLowerCase()}`),
        )
        .slice(0, MAX_EXTRA_CUSTOM)
    : [];
  const effectiveCustom: Record<string, MetricAggregate> = { ...customMetrics };
  for (const c of extra) effectiveCustom[c.name.toLowerCase()] ??= 'avg';
  const matched = categories.filter((c) => wanted.has(c.name.toLowerCase()) || extra.includes(c));
  const [daily, checkIns, exerciseDays, report, sleep, water, fasts, customRows] =
    await Promise.all([
      settle('daily', sparky.dailyHealthMetrics(token, start, end), []),
      settle('checkins', sparky.checkIns(token, start, end), []),
      settle('exercise-days', sparky.exerciseDays(token, start, end), []),
      settle('report', sparky.report(token, start, end), { exerciseEntries: [], nutrition: [] }),
      settle('sleep', sparky.sleep(token, start, end), []),
      settle('water', sparky.water(token, start, end), []),
      // A fast that ends on the first day started the day before.
      settle('fasting', sparky.fasts(token, addDays(start, -1), end), []),
      Promise.all(
        matched.map(
          async (c) =>
            [
              c,
              await settle(
                `custom:${c.name}`,
                sparky.customMeasurements(token, c.id, start, end),
                [] as CustomMeasurementRow[],
              ),
            ] as const,
        ),
      ),
    ]);

  const custom: MergeInput['custom'] = {};
  for (const [category, rows] of customRows) {
    const key = category.name.toLowerCase();
    const existing = custom[key];
    custom[key] = existing ? { category, rows: [...existing.rows, ...rows] } : { category, rows };
  }

  let goals: Record<string, GoalsRow> | undefined;
  if (opts.goals) {
    goals = { ...opts.goals.known };
    const logged = new Set<string>();
    for (const r of report.nutrition) if (r.date) logged.add(String(r.date).slice(0, 10));
    for (const r of water) if (r.entry_date) logged.add(String(r.entry_date).slice(0, 10));
    const cap = opts.goals.maxFetches ?? MAX_GOAL_FETCHES;
    const missing = [...logged]
      .filter((d) => d >= start && d <= end && !goals![d])
      .sort()
      .reverse()
      .slice(0, cap);
    for (let i = 0; i < missing.length; i += 4) {
      const batch = missing.slice(i, i + 4);
      const got = await Promise.all(
        batch.map((d) => settle(`goals:${d}`, sparky.goalsByDate(token, d), null)),
      );
      batch.forEach((d, j) => {
        if (got[j]) goals![d] = got[j]!;
      });
    }
  }

  return {
    merged: mergeDaily({
      start,
      end,
      daily,
      checkIns,
      custom,
      exerciseDays,
      exerciseEntries: report.exerciseEntries,
      sleep,
      customMetrics: effectiveCustom,
      nutrition: report.nutrition,
      water,
      goals,
      fasts,
      lifts: [
        ...new Set([
          ...(opts.lifts ?? []),
          ...(opts.allLifts
            ? liftOptions(report.exerciseEntries)
                .slice(0, MAX_LIFTS)
                .map((l) => l.key)
            : []),
        ]),
      ],
      timezone: opts.timezone,
    }),
    partial,
  };
}

/**
 * The workouts, lift sessions and finished fasts SparkyFitness has for a date range, ready to
 * list. Asks only for what the kinds need (one report call, and the fasting log for fasts).
 */
export async function fetchEvents(
  sparky: SparkyClient,
  token: string,
  start: string,
  end: string,
  opts: { kinds: ('workout' | 'lift' | 'fast')[]; timezone?: string },
): Promise<{ date: string; event: ChallengeEvent }[]> {
  const needsReport = opts.kinds.includes('workout') || opts.kinds.includes('lift');
  const [report, fasts] = await Promise.all([
    needsReport ? sparky.report(token, start, end) : { exerciseEntries: [], nutrition: [] },
    opts.kinds.includes('fast') ? sparky.fasts(token, addDays(start, -1), addDays(end, 1)) : [],
  ]);
  return buildEvents({
    start,
    end,
    exerciseEntries: report.exerciseEntries,
    fasts,
    timezone: opts.timezone,
  }).filter((e) => opts.kinds.includes(e.event.kind as 'workout' | 'lift' | 'fast'));
}
