import {
  buildToday,
  buildTrends,
  isMetricKey,
  personalBests,
  todayIn,
  trendsNeedFrom,
  trendsQuerySchema,
  updateMeSchema,
  type CustomMetricOption,
  type MetricRow,
  type TodayResponse,
  type TrendsResponse,
} from '@gauntlet/shared';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireUser, revokeAllRefreshTokens } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest } from '../context.js';
import { challengeParticipants, dailyMetrics, rankSnapshots, users } from '../db/schema.js';
import { listForUser } from '../services/challenges.js';
import { syncUser } from '../services/sync.js';
import { getUser, isValidTimeZone, sparkyToken, toMe } from '../services/users.js';
import { DISTANCE_CATEGORIES, RESTING_HR_CATEGORIES } from '@gauntlet/sparky';

export function meRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireUser(ctx) };

  app.get('/api/me', auth, async (req) => toMe(await getUser(ctx, req.userId)));

  app.patch('/api/me', auth, async (req) => {
    const body = updateMeSchema.parse(req.body);
    if (body.timezone && !isValidTimeZone(body.timezone)) throw badRequest('Unknown time zone');
    const [u] = await ctx.db
      .update(users)
      .set({
        ...(body.displayName ? { displayName: body.displayName } : {}),
        ...(body.timezone ? { timezone: body.timezone } : {}),
        ...(body.settings?.shareWorkoutDetails != null
          ? { shareWorkoutDetails: body.settings.shareWorkoutDetails }
          : {}),
        ...(body.settings?.healthConnectSync != null
          ? { healthConnectSync: body.settings.healthConnectSync }
          : {}),
      })
      .where(eq(users.id, req.userId))
      .returning();
    return toMe(u!);
  });

  /** Pull fresh data from SparkyFitness now (pull-to-refresh). */
  app.post(
    '/api/me/sync',
    { ...auth, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async (req) => {
      return syncUser(ctx, req.userId);
    },
  );

  app.get('/api/me/today', auth, async (req): Promise<TodayResponse> => {
    const user = await getUser(ctx, req.userId);
    const date = todayIn(user.timezone, ctx.now());
    const rows = await ctx.db
      .select({ date: dailyMetrics.date, metric: dailyMetrics.metric, value: dailyMetrics.value })
      .from(dailyMetrics)
      .where(and(eq(dailyMetrics.userId, user.id), eq(dailyMetrics.date, date)));
    const featured =
      (await listForUser(ctx, user.id)).find(
        (c) => c.status === 'active' && c.myState === 'joined',
      ) ?? null;
    return {
      ...buildToday(rows, date),
      lastSyncedAt: user.lastSyncedAt?.toISOString() ?? null,
      featured,
    };
  });

  app.get('/api/me/trends', auth, async (req): Promise<TrendsResponse> => {
    const q = trendsQuerySchema.parse(req.query);
    const user = await getUser(ctx, req.userId);
    const today = todayIn(user.timezone, ctx.now());
    const rows = await ctx.db
      .select({ date: dailyMetrics.date, metric: dailyMetrics.metric, value: dailyMetrics.value })
      .from(dailyMetrics)
      .where(
        and(
          eq(dailyMetrics.userId, user.id),
          eq(dailyMetrics.metric, q.metric),
          gte(dailyMetrics.date, trendsNeedFrom(q.range, today)),
        ),
      );

    // Rank history from the most recent challenge with snapshots.
    const snaps = await ctx.db
      .select({
        challengeId: rankSnapshots.challengeId,
        date: rankSnapshots.date,
        rank: rankSnapshots.rank,
      })
      .from(rankSnapshots)
      .where(eq(rankSnapshots.userId, user.id))
      .orderBy(desc(rankSnapshots.date))
      .limit(200);
    let rankHistory: TrendsResponse['rankHistory'] = null;
    const latest = snaps[0];
    if (latest) {
      const list = (await listForUser(ctx, user.id)).find((c) => c.id === latest.challengeId);
      const points = snaps
        .filter((s) => s.challengeId === latest.challengeId)
        .map((s) => ({ date: s.date, rank: s.rank }))
        .reverse();
      rankHistory = { challengeId: latest.challengeId, name: list?.name ?? 'Challenge', points };
    }

    return {
      ...buildTrends({ rows, range: q.range, metric: q.metric, today }),
      rankHistory,
      personalBests: personalBests(await bestsRows(ctx, user.id), {
        today,
        challengesWon: await challengesWon(ctx, user.id),
      }),
    };
  });

  app.get('/api/me/custom-metrics', auth, async (req): Promise<CustomMetricOption[]> => {
    const user = await getUser(ctx, req.userId);
    const cats = await ctx.sparky.customCategories(sparkyToken(ctx, user));
    const builtin = new Set([...DISTANCE_CATEGORIES, ...RESTING_HR_CATEGORIES]);
    return cats
      .filter((c) => (c.data_type ?? 'numeric') === 'numeric' && !builtin.has(c.name.toLowerCase()))
      .filter((c) => isMetricKey(`custom:${c.name.toLowerCase()}`))
      .map((c) => ({
        categoryId: c.id,
        label: c.display_name || c.name,
        unit: c.measurement_type && c.measurement_type !== 'N/A' ? c.measurement_type : null,
      }));
  });

  /** Delete the Gauntlet account and the API key it holds. SparkyFitness data is untouched. */
  app.delete('/api/me', auth, async (req) => {
    const user = await getUser(ctx, req.userId);
    if (user.sparkyKeyId && user.sparkyKeyEnc && user.keyStatus === 'active') {
      // A key can delete itself, which revokes Gauntlet's access.
      await ctx.sparky
        .deleteApiKey(sparkyToken(ctx, user), user.sparkyKeyId)
        .catch(() => undefined);
    }
    await revokeAllRefreshTokens(ctx, user.id);
    await ctx.db.delete(users).where(eq(users.id, user.id));
    return { ok: true };
  });
}

/** Rows the personal-bests tiles are computed from (steps and distance, all time). */
function bestsRows(ctx: AppContext, userId: string): Promise<MetricRow[]> {
  return ctx.db
    .select({ date: dailyMetrics.date, metric: dailyMetrics.metric, value: dailyMetrics.value })
    .from(dailyMetrics)
    .where(
      and(eq(dailyMetrics.userId, userId), inArray(dailyMetrics.metric, ['steps', 'distance'])),
    );
}

async function challengesWon(ctx: AppContext, userId: string): Promise<number> {
  const [wins] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(challengeParticipants)
    .where(and(eq(challengeParticipants.userId, userId), eq(challengeParticipants.finalRank, 1)));
  return wins?.n ?? 0;
}
