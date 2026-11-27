/**
 * Per-workout summaries for badges. Sync hands us the cleaned workout list for its window; we keep
 * one row each (sport, size, local start hour) so rules like "a 10 km run" or "a workout before
 * 6 am" are a query, not a SparkyFitness call. A workout SparkyFitness no longer has is removed,
 * mirroring how daily_metrics treats deletions.
 */
import { sportOf, type WorkoutSummary } from '@gauntlet/shared';
import { and, eq, gte, lte, notInArray, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { activities } from '../../db/schema.js';

/** Entries SparkyFitness labels as typed in by hand rather than recorded by a device or app. */
export function looksManual(source: string | null | undefined): boolean {
  return !!source && /\bmanual\b|^logged workouts$/i.test(source);
}

/** Local hour 0-23 a workout started, from its ISO instant (in the person's zone) or wall-clock time. */
export function startHourOf(
  w: Pick<WorkoutSummary, 'startedAt' | 'startTime'>,
  timezone: string,
): number | null {
  if (w.startedAt) {
    try {
      const h = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(w.startedAt));
      const n = Number.parseInt(h, 10);
      if (Number.isFinite(n)) return n % 24;
    } catch {
      /* fall through to the wall-clock time */
    }
  }
  const m = /^(\d{2}):/.exec(w.startTime ?? '');
  return m ? Number.parseInt(m[1]!, 10) : null;
}

export function toActivityRow(userId: string, w: WorkoutSummary, timezone: string, now: Date) {
  return {
    userId,
    id: w.id,
    date: w.date,
    sport: sportOf(w.name, w.kind),
    name: w.name.slice(0, 120),
    startHour: startHourOf(w, timezone),
    minutes: w.minutes,
    distanceKm: w.distanceKm,
    kcal: w.kcal,
    source: w.source,
    manual: looksManual(w.source),
    updatedAt: now,
  };
}

/**
 * Upsert the workouts a sync saw in [start, end] and drop the ones in that window it no longer
 * sees (unless a source failed to load: then what we have is kept).
 */
export async function storeActivities(
  ctx: AppContext,
  userId: string,
  timezone: string,
  start: string,
  end: string,
  workouts: WorkoutSummary[],
  partial: boolean,
): Promise<void> {
  const rows = workouts.map((w) => toActivityRow(userId, w, timezone, ctx.now()));
  await ctx.db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      await tx
        .insert(activities)
        .values(chunk)
        .onConflictDoUpdate({
          target: [activities.userId, activities.id],
          set: {
            date: sqlExcluded('date'),
            sport: sqlExcluded('sport'),
            name: sqlExcluded('name'),
            startHour: sqlExcluded('start_hour'),
            minutes: sqlExcluded('minutes'),
            distanceKm: sqlExcluded('distance_km'),
            kcal: sqlExcluded('kcal'),
            source: sqlExcluded('source'),
            manual: sqlExcluded('manual'),
            updatedAt: ctx.now(),
          },
        });
    }
    if (partial) return;
    const window = and(
      eq(activities.userId, userId),
      gte(activities.date, start),
      lte(activities.date, end),
    );
    const ids = rows.map((r) => r.id);
    await tx
      .delete(activities)
      .where(ids.length ? and(window, notInArray(activities.id, ids)) : window);
  });
}

function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}
