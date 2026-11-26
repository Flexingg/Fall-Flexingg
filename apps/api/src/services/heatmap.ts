/**
 * The calendar heatmap: one daily number per day for a year. It is part of the "stats" side of a
 * profile, so it follows the same rule as all-time stats: you always see your own; other people's
 * only when they can be seen at all (canSeeUser) and have turned on "share stats".
 */
import {
  HEATMAP_METRICS,
  addDays,
  todayIn,
  type HeatmapMetricKey,
  type HeatmapResponse,
} from '@gauntlet/shared';
import { and, asc, between, eq, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { forbidden, notFound } from '../context.js';
import { dailyMetrics } from '../db/schema.js';
import { canSeeUser } from './privacy.js';
import { getUsers } from './users.js';

export async function getHeatmap(
  ctx: AppContext,
  viewerId: string,
  targetId: string,
  metric: HeatmapMetricKey,
  year?: number,
): Promise<HeatmapResponse> {
  const u = /^[0-9a-f-]{36}$/i.test(targetId)
    ? (await getUsers(ctx, [targetId])).get(targetId)
    : undefined;
  // Same answer as the profile itself for people you can't see at all.
  if (!u || !(await canSeeUser(ctx, viewerId, u))) throw notFound('Person not found');
  if (viewerId !== u.id && !u.shareProfileStats)
    throw forbidden('This person keeps their stats to themselves');

  const today = todayIn(u.timezone, ctx.now());
  let start = addDays(today, -364);
  let end = today;
  if (year != null) {
    start = `${year}-01-01`;
    end = `${year}-12-31` < today ? `${year}-12-31` : today;
    if (end < start) end = start;
  }
  const def = HEATMAP_METRICS.find((m) => m.key === metric)!;
  const rows = await ctx.db
    .select({ date: sql<string>`${dailyMetrics.date}::text`, value: dailyMetrics.value })
    .from(dailyMetrics)
    .where(
      and(
        eq(dailyMetrics.userId, u.id),
        eq(dailyMetrics.metric, metric),
        between(dailyMetrics.date, start, end),
        sql`${dailyMetrics.value} > 0`,
      ),
    )
    .orderBy(asc(dailyMetrics.date));
  return {
    metric,
    label: def.label,
    unit: def.unit,
    decimals: def.decimals,
    start,
    end,
    days: rows.map((r) => [r.date, Math.round(r.value * 100) / 100]),
  };
}
