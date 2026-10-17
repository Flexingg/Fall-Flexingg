import {
  addDays,
  buildOverview,
  buildToday,
  buildTrends,
  buildWallpaper,
  isMetricKey,
  personalBests,
  todayIn,
  trendsNeedFrom,
  trendsQuerySchema,
  startFastSchema,
  updateMeSchema,
  type CustomMetricOption,
  type FastStatus,
  type LiftOption,
  type MetricRow,
  type TodayResponse,
  type TrendsOverview,
  type TrendsResponse,
  type WallpaperResponse,
  WALLPAPER_HISTORY_DAYS,
} from '@gauntlet/shared';
import { and, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireUser, revokeAllRefreshTokens } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest, HttpError } from '../context.js';
import { challengeParticipants, dailyMetrics, rankSnapshots, users } from '../db/schema.js';
import { listForUser } from '../services/challenges.js';
import { syncUser } from '../services/sync.js';
import {
  demoBlocked,
  getUser,
  isValidTimeZone,
  sparkyToken,
  toMe,
  type UserRow,
} from '../services/users.js';
import {
  DISTANCE_CATEGORIES,
  liftOptions,
  listConnections,
  RESTING_HR_CATEGORIES,
  SparkyError,
  type FastRow,
} from '@gauntlet/sparky';
import { connectionsEnv } from './connections.js';

const WALLPAPER_METRICS = [
  'calories_in',
  'protein',
  'carbs',
  'fat',
  'water',
  'lift_volume',
  'goal_calories',
  'goal_protein',
  'goal_carbs',
  'goal_fat',
  'goal_water',
];

export function meRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireUser(ctx) };

  app.get('/api/me', auth, async (req) => toMe(await getUser(ctx, req.userId), ctx));

  app.patch('/api/me', auth, async (req) => {
    if (req.isDemo) throw demoBlocked();
    const body = updateMeSchema.parse(req.body);
    if (body.timezone && !isValidTimeZone(body.timezone)) throw badRequest('Unknown time zone');
    if (body.handle) {
      const [taken] = await ctx.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.handle, body.handle), ne(users.id, req.userId)));
      if (taken) throw new HttpError(409, 'That handle is taken', 'handle_taken');
    }
    const [u] = await ctx.db
      .update(users)
      .set({
        ...(body.displayName ? { displayName: body.displayName } : {}),
        ...(body.timezone ? { timezone: body.timezone } : {}),
        ...(body.settings?.shareWorkoutDetails != null
          ? { shareWorkoutDetails: body.settings.shareWorkoutDetails }
          : {}),
        ...(body.settings?.shareEvents != null ? { shareEvents: body.settings.shareEvents } : {}),
        ...(body.settings?.healthConnectSync != null
          ? { healthConnectSync: body.settings.healthConnectSync }
          : {}),
        ...(body.visibility ? { visibility: body.visibility } : {}),
        ...(body.handle !== undefined ? { handle: body.handle || null } : {}),
      })
      .where(eq(users.id, req.userId))
      .returning();
    return toMe(u!, ctx);
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
      hasSources: await hasSources(ctx, user, date),
    };
  });

  /** Today's food, water and lifting against the person's goals, for the Android live wallpaper. */
  app.get('/api/me/wallpaper', auth, async (req): Promise<WallpaperResponse> => {
    const user = await getUser(ctx, req.userId);
    const date = todayIn(user.timezone, ctx.now());
    const rows = await ctx.db
      .select({ date: dailyMetrics.date, metric: dailyMetrics.metric, value: dailyMetrics.value })
      .from(dailyMetrics)
      .where(
        and(
          eq(dailyMetrics.userId, user.id),
          inArray(dailyMetrics.metric, WALLPAPER_METRICS),
          gte(dailyMetrics.date, addDays(date, -WALLPAPER_HISTORY_DAYS)),
          lte(dailyMetrics.date, date),
        ),
      );
    return buildWallpaper(rows, date, user.timezone);
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

  /** Every stat the person has data for, summarised for a range (the Trends overview). */
  app.get('/api/me/trends/overview', auth, async (req): Promise<TrendsOverview> => {
    const { range } = trendsQuerySchema.pick({ range: true }).parse(req.query);
    const user = await getUser(ctx, req.userId);
    const today = todayIn(user.timezone, ctx.now());
    // Two months of rows cover every range plus its comparison period, and the list to pick from.
    const rows = await ctx.db
      .select({ date: dailyMetrics.date, metric: dailyMetrics.metric, value: dailyMetrics.value })
      .from(dailyMetrics)
      .where(
        and(
          eq(dailyMetrics.userId, user.id),
          gte(dailyMetrics.date, trendsNeedFrom('month', today)),
        ),
      );
    return buildOverview({ rows, range, today });
  });

  app.get('/api/me/custom-metrics', auth, async (req): Promise<CustomMetricOption[]> => {
    const user = await getUser(ctx, req.userId);
    if (user.isDemo) return [];
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

  /** Exercises with weighted sets in the last four months, for per-exercise strength challenges. */
  app.get('/api/me/lifts', auth, async (req): Promise<LiftOption[]> => {
    const user = await getUser(ctx, req.userId);
    if (user.isDemo) return [];
    const today = todayIn(user.timezone, ctx.now());
    const { exerciseEntries } = await ctx.sparky.report(
      sparkyToken(ctx, user),
      addDays(today, -120),
      today,
    );
    return liftOptions(exerciseEntries);
  });

  /** SparkyFitness' fasting tracker: what's running, start one, end it. */
  app.get('/api/me/fast', auth, async (req): Promise<FastStatus> => {
    const user = await getUser(ctx, req.userId);
    if (user.isDemo) return { active: null };
    return toFastStatus(await ctx.sparky.currentFast(sparkyToken(ctx, user)));
  });

  app.post('/api/me/fast/start', auth, async (req): Promise<FastStatus> => {
    const { hours } = startFastSchema.parse(req.body);
    const user = await getUser(ctx, req.userId);
    const now = ctx.now();
    try {
      const fast = await ctx.sparky.startFast(sparkyToken(ctx, user), {
        start_time: now.toISOString(),
        target_end_time: new Date(now.getTime() + hours * 3_600_000).toISOString(),
        fasting_type: `${hours}h`,
      });
      return toFastStatus(fast);
    } catch (err) {
      if (err instanceof SparkyError && err.status === 400)
        throw badRequest('You already have a fast running.', 'fast_running');
      throw err;
    }
  });

  app.post('/api/me/fast/end', auth, async (req): Promise<FastStatus> => {
    const user = await getUser(ctx, req.userId);
    const token = sparkyToken(ctx, user);
    const current = await ctx.sparky.currentFast(token);
    if (!current) throw badRequest('No fast is running.', 'no_fast');
    await ctx.sparky.endFast(token, current.id, ctx.now().toISOString());
    void syncUser(ctx, user.id).catch(() => undefined);
    return { active: null };
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

/**
 * Does anything feed this account? Recent data answers it cheaply; only people with none (new
 * accounts, mostly) cost a look at their linked apps. If SparkyFitness can't say, don't nag.
 */
async function hasSources(ctx: AppContext, user: UserRow, today: string): Promise<boolean> {
  if (user.healthConnectSync || user.isDemo) return true;
  const [recent] = await ctx.db
    .select({ n: sql<number>`1` })
    .from(dailyMetrics)
    .where(and(eq(dailyMetrics.userId, user.id), gte(dailyMetrics.date, addDays(today, -30))))
    .limit(1);
  if (recent) return true;
  try {
    const apps = await listConnections(ctx.sparky, sparkyToken(ctx, user), connectionsEnv(ctx));
    return apps.some((a) => a.state === 'connected');
  } catch {
    return true;
  }
}

function toFastStatus(f: FastRow | null): FastStatus {
  if (!f || (f.status ?? '').toUpperCase() !== 'ACTIVE') return { active: null };
  return {
    active: { id: f.id, startedAt: f.start_time, targetEndAt: f.target_end_time ?? null },
  };
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
