import type { MetricAggregate } from '@gauntlet/shared';
import type { CustomMeasurementRow, SparkyClient } from './client.js';
import { SparkyError } from './client.js';
import { mergeDaily, wantedCategoryNames, type MergedValue, type MergeInput } from './merge.js';

/**
 * Read everything Gauntlet scores from SparkyFitness for a date range and merge it into one value
 * per day and metric. Used by the API and by the Android app's direct mode, so both agree.
 *
 * A source that fails is skipped (reported through `onSkip`, and `partial` is set) so one flaky
 * endpoint doesn't blank the whole app. A rejected key (401) always throws.
 */
export async function fetchMerged(
  sparky: SparkyClient,
  token: string,
  start: string,
  end: string,
  customMetrics: Record<string, MetricAggregate> = {},
  onSkip: (label: string, err: Error) => void = () => {},
): Promise<{ merged: MergedValue[]; partial: boolean }> {
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
  const matched = categories.filter((c) => wanted.has(c.name.toLowerCase()));
  const [daily, checkIns, exerciseDays, exerciseEntries, sleep, customRows] = await Promise.all([
    settle('daily', sparky.dailyHealthMetrics(token, start, end), []),
    settle('checkins', sparky.checkIns(token, start, end), []),
    settle('exercise-days', sparky.exerciseDays(token, start, end), []),
    settle('exercise-entries', sparky.exerciseEntries(token, start, end), []),
    settle('sleep', sparky.sleep(token, start, end), []),
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
