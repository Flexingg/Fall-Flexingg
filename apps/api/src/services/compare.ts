/**
 * Head to head: you and another person over one range, plus how you have done against each other
 * in finished challenges. The window and totals come from the same code as Trends (buildTrends),
 * measured on your calendar for both of you so the two columns cover the same days.
 * Their numbers follow their profile choice (shareProfileStats): when it is off, only the
 * challenge record is returned. Weight, food and sleep are never part of it. Who can be compared
 * is exactly who can open the profile (canSeeUser).
 */
import {
  buildTrends,
  COMPARE_METRICS,
  todayIn,
  trendDef,
  trendsNeedFrom,
  type CompareMetric,
  type CompareResponse,
  type MetricRow,
  type TrendRange,
} from '@gauntlet/shared';
import { aliasedTable, and, eq, gte, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../context.js';
import { challengeParticipants, challenges, dailyMetrics } from '../db/schema.js';
import { canSeeUser } from './privacy.js';
import { getUser, getUsers } from './users.js';

async function rowsFor(ctx: AppContext, userId: string, from: string): Promise<MetricRow[]> {
  return ctx.db
    .select({ date: dailyMetrics.date, metric: dailyMetrics.metric, value: dailyMetrics.value })
    .from(dailyMetrics)
    .where(
      and(
        eq(dailyMetrics.userId, userId),
        inArray(dailyMetrics.metric, [...COMPARE_METRICS]),
        gte(dailyMetrics.date, from),
      ),
    );
}

/** Finished group challenges you were both scored in: who placed higher. Ties count for neither. */
async function sharedRecord(ctx: AppContext, a: string, b: string) {
  const mine = challengeParticipants;
  const theirs = aliasedTable(challengeParticipants, 'theirs');
  const rows = await ctx.db
    .select({ mine: mine.finalRank, theirs: theirs.finalRank })
    .from(mine)
    .innerJoin(theirs, eq(theirs.challengeId, mine.challengeId))
    .innerJoin(challenges, eq(challenges.id, mine.challengeId))
    .where(
      and(
        eq(mine.userId, a),
        eq(theirs.userId, b),
        eq(mine.state, 'joined'),
        eq(theirs.state, 'joined'),
        isNotNull(mine.finalRank),
        isNotNull(theirs.finalRank),
        isNotNull(mine.finalScore),
        isNotNull(theirs.finalScore),
        isNotNull(challenges.finalizedAt),
        isNull(challenges.solo),
      ),
    );
  return {
    me: rows.filter((r) => r.mine! < r.theirs!).length,
    them: rows.filter((r) => r.theirs! < r.mine!).length,
    shared: rows.length,
  };
}

export async function compareWith(
  ctx: AppContext,
  viewerId: string,
  targetId: string,
  range: TrendRange,
): Promise<CompareResponse> {
  const target = /^[0-9a-f-]{36}$/i.test(targetId)
    ? (await getUsers(ctx, [targetId])).get(targetId)
    : undefined;
  if (!target || !(await canSeeUser(ctx, viewerId, target))) throw notFound('Person not found');
  if (target.id === viewerId) throw badRequest("That's you. Pick someone else to compare with.");

  const me = await getUser(ctx, viewerId);
  const today = todayIn(me.timezone, ctx.now());
  const theirsHidden = !target.shareProfileStats;
  const record = await sharedRecord(ctx, viewerId, target.id);
  const base = { range, record, theirsHidden, theirName: target.displayName };
  if (theirsHidden) return { ...base, metrics: [] };

  const from = trendsNeedFrom(range, today);
  const [mine, theirs] = await Promise.all([
    rowsFor(ctx, viewerId, from),
    rowsFor(ctx, target.id, from),
  ]);
  const total = (rows: MetricRow[], metric: string) =>
    buildTrends({ rows, range, metric, today }).total;
  const metrics: CompareMetric[] = [];
  for (const key of COMPARE_METRICS) {
    const def = trendDef(key)!;
    const [m, t] = [total(mine, key), total(theirs, key)];
    // Only what either of you has data for.
    if (m <= 0 && t <= 0) continue;
    metrics.push({ key, label: def.label, unit: def.unit, me: m, them: t });
  }
  return { ...base, metrics };
}
