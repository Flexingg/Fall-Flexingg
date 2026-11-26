/**
 * Someone's profile as one viewer is allowed to see it. Who can open a profile at all is the same as
 * everywhere else (canSeeUser): friends, pending requests, challenge-mates, or anyone when it's
 * public. Within that:
 *  - name, handle, record and trophies follow the profile itself;
 *  - all-time stats and milestones are shown to others only when the person turns on
 *    "shareProfileStats", and always to the person themselves;
 *  - weight, nutrition and sleep are never part of a profile.
 * A trophy from a private challenge the viewer wasn't in shows its place but not its name.
 */
import {
  longestRun,
  metricDef,
  milestones,
  type AllTimeStats,
  type MetricKey,
  type ProfileResponse,
  type Trophy,
} from '@gauntlet/shared';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { notFound } from '../context.js';
import { challengeParticipants, challenges, dailyMetrics } from '../db/schema.js';
import { canSeeUser, toCards } from './privacy.js';
import { getUsers } from './users.js';

const STAT_METRICS = [
  'steps',
  'distance',
  'active_minutes',
  'active_calories',
  'workouts',
  'lift_volume',
  'lift_sets',
  'fast_hours',
] as const;

export async function getProfile(
  ctx: AppContext,
  viewerId: string,
  targetId: string,
): Promise<ProfileResponse> {
  const u = /^[0-9a-f-]{36}$/i.test(targetId)
    ? (await getUsers(ctx, [targetId])).get(targetId)
    : undefined;
  if (!u || !(await canSeeUser(ctx, viewerId, u))) throw notFound('Person not found');
  const isMe = viewerId === u.id;
  const [card] = await toCards(ctx, viewerId, [u]);

  const trophies = await getTrophies(ctx, viewerId, u.id);
  const showStats = isMe || u.shareProfileStats;
  const stats = showStats ? await allTimeStats(ctx, u.id) : null;
  return {
    user: {
      ...card!,
      visibility: u.visibility,
      memberSince: u.createdAt.toISOString().slice(0, 10),
    },
    trophies,
    stats,
    // Wins here are real podium firsts (no solo or walkover "wins"), matching the trophy board.
    milestones: stats ? milestones(stats, trophies.gold) : null,
    shared: u.shareProfileStats,
  };
}

/** Podium finishes in finished group challenges (two or more people with a score). */
async function getTrophies(
  ctx: AppContext,
  viewerId: string,
  userId: string,
): Promise<ProfileResponse['trophies']> {
  const rows = await ctx.db
    .select({
      challengeId: challenges.id,
      name: challenges.name,
      metric: challenges.metric,
      customLabel: challenges.customLabel,
      customUnit: challenges.customUnit,
      aggregate: challenges.aggregate,
      lowerIsBetter: challenges.lowerIsBetter,
      visibility: challenges.visibility,
      endDate: challenges.endDate,
      rank: challengeParticipants.finalRank,
      field: sql<number>`(select count(*)::int from challenge_participants f
        where f.challenge_id = ${challenges.id} and f.state = 'joined' and f.final_score is not null)`,
      viewerIn: sql<boolean>`exists (select 1 from challenge_participants v
        where v.challenge_id = ${challenges.id} and v.user_id = ${viewerId}
          and v.state in ('invited', 'joined'))`,
    })
    .from(challengeParticipants)
    .innerJoin(challenges, eq(challenges.id, challengeParticipants.challengeId))
    .where(
      and(
        eq(challengeParticipants.userId, userId),
        eq(challengeParticipants.state, 'joined'),
        isNotNull(challengeParticipants.finalScore),
        lte(challengeParticipants.finalRank, 3),
        gte(challengeParticipants.finalRank, 1),
        isNull(challenges.solo),
        isNotNull(challenges.finalizedAt),
      ),
    )
    .orderBy(desc(challenges.endDate));

  const list: Trophy[] = rows
    .filter((r) => r.field >= 2 && r.rank != null && r.rank <= r.field)
    .map((r) => {
      const known = r.visibility === 'public' || r.viewerIn || viewerId === userId;
      let metricLabel: string | null = null;
      try {
        metricLabel = metricDef(
          r.metric as MetricKey,
          r.customLabel
            ? {
                label: r.customLabel,
                unit: r.customUnit ?? undefined,
                aggregate: r.aggregate,
                lowerIsBetter: r.lowerIsBetter,
              }
            : undefined,
        ).label;
      } catch {
        metricLabel = null;
      }
      return {
        challengeId: known ? r.challengeId : null,
        name: known ? r.name : 'Private challenge',
        rank: r.rank!,
        field: r.field,
        endDate: r.endDate,
        metricLabel: known ? metricLabel : null,
      };
    });
  return {
    gold: list.filter((t) => t.rank === 1).length,
    silver: list.filter((t) => t.rank === 2).length,
    bronze: list.filter((t) => t.rank === 3).length,
    list,
  };
}

/** Totals and bests over every day Gauntlet has for this person. */
export async function allTimeStats(ctx: AppContext, userId: string): Promise<AllTimeStats> {
  const rows = await ctx.db
    .select({
      metric: dailyMetrics.metric,
      total: sql<number>`coalesce(sum(${dailyMetrics.value}), 0)::float8`,
      best: sql<number | null>`max(${dailyMetrics.value})::float8`,
    })
    .from(dailyMetrics)
    .where(and(eq(dailyMetrics.userId, userId), inArray(dailyMetrics.metric, [...STAT_METRICS])))
    .groupBy(dailyMetrics.metric);
  const by = new Map(rows.map((r) => [r.metric, r]));
  const total = (m: string) => by.get(m)?.total ?? 0;
  const best = (m: string) => {
    const v = by.get(m)?.best;
    return v != null && v > 0 ? v : null;
  };

  const [span] = await ctx.db
    .select({
      since: sql<string | null>`min(${dailyMetrics.date})::text`,
      days: sql<number>`count(distinct ${dailyMetrics.date})::int`,
    })
    .from(dailyMetrics)
    .where(and(eq(dailyMetrics.userId, userId), inArray(dailyMetrics.metric, [...STAT_METRICS])));

  const streakDays = await ctx.db
    .select({ date: dailyMetrics.date })
    .from(dailyMetrics)
    .where(
      and(
        eq(dailyMetrics.userId, userId),
        eq(dailyMetrics.metric, 'steps'),
        gte(dailyMetrics.value, 10_000),
      ),
    );

  return {
    since: span?.since ?? null,
    daysTracked: span?.days ?? 0,
    totals: {
      steps: Math.round(total('steps')),
      distanceKm: Math.round(total('distance') * 10) / 10,
      activeMinutes: Math.round(total('active_minutes')),
      activeCalories: Math.round(total('active_calories')),
      workouts: Math.round(total('workouts')),
      liftVolumeKg: Math.round(total('lift_volume')),
      liftSets: Math.round(total('lift_sets')),
      fastHours: Math.round(total('fast_hours') * 10) / 10,
    },
    bests: {
      steps: best('steps') != null ? Math.round(best('steps')!) : null,
      distanceKm: best('distance') != null ? Math.round(best('distance')! * 10) / 10 : null,
      liftVolumeKg: best('lift_volume') != null ? Math.round(best('lift_volume')!) : null,
      longestFastHours:
        best('fast_hours') != null ? Math.round(best('fast_hours')! * 10) / 10 : null,
      stepStreakDays: longestRun(streakDays.map((r) => r.date)),
    },
  };
}
