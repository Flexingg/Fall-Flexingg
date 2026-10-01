import {
  addDays,
  isMetricKey,
  listDates,
  METRICS,
  todayIn,
  trendsQuerySchema,
  updateMeSchema,
  weekday,
  type CustomMetricOption,
  type TodayResponse,
  type TrendsResponse,
} from '@gauntlet/shared';
import { and, asc, desc, eq, gte, lte, max, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireUser, revokeAllRefreshTokens } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest } from '../context.js';
import { challengeParticipants, dailyMetrics, rankSnapshots, users } from '../db/schema.js';
import { listForUser } from '../services/challenges.js';
import { syncUser } from '../services/sync.js';
import { getUser, isValidTimeZone, sparkyToken, toMe } from '../services/users.js';
import { DISTANCE_CATEGORIES, RESTING_HR_CATEGORIES } from '../sparky/merge.js';

const DAILY_GOALS = { steps: 10_000, active_calories: 500, active_minutes: 30 } as const;

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
      .select()
      .from(dailyMetrics)
      .where(and(eq(dailyMetrics.userId, user.id), eq(dailyMetrics.date, date)));
    const val = (m: string) => rows.find((r) => r.metric === m)?.value ?? null;
    const featured =
      (await listForUser(ctx, user.id)).find(
        (c) => c.status === 'active' && c.myState === 'joined',
      ) ?? null;
    return {
      date,
      lastSyncedAt: user.lastSyncedAt?.toISOString() ?? null,
      metrics: (['steps', 'active_calories', 'active_minutes', 'distance'] as const).map((k) => ({
        key: k,
        label: k === 'active_calories' ? 'Active kcal' : METRICS[k].label,
        value: val(k),
        unit: METRICS[k].unit,
        goal: k in DAILY_GOALS ? DAILY_GOALS[k as keyof typeof DAILY_GOALS] : null,
      })),
      featured,
    };
  });

  app.get('/api/me/trends', auth, async (req): Promise<TrendsResponse> => {
    const q = trendsQuerySchema.parse(req.query);
    const user = await getUser(ctx, req.userId);
    const today = todayIn(user.timezone, ctx.now());
    let start: string;
    let end: string;
    if (q.range === 'week') {
      start = addDays(today, -((weekday(today) + 6) % 7)); // Monday
      end = addDays(start, 6);
    } else if (q.range === 'month') {
      start = addDays(today, -29);
      end = today;
    } else {
      start = addDays(today, -6);
      end = today;
    }
    const span = listDates(start, end).length;
    const prevStart = addDays(start, -span);
    const rows = await ctx.db
      .select({ date: dailyMetrics.date, value: dailyMetrics.value })
      .from(dailyMetrics)
      .where(
        and(
          eq(dailyMetrics.userId, user.id),
          eq(dailyMetrics.metric, q.metric),
          gte(dailyMetrics.date, prevStart),
          lte(dailyMetrics.date, end),
        ),
      );
    const byDate = new Map(rows.map((r) => [r.date, r.value]));
    const avg = q.metric === 'sleep' || q.metric === 'resting_hr';
    const agg = (dates: string[]) => {
      const vals = dates.map((d) => byDate.get(d)).filter((v): v is number => v != null);
      if (!vals.length) return 0;
      const sum = vals.reduce((a, b) => a + b, 0);
      return avg ? sum / vals.length : sum;
    };
    // Compare like with like: only the elapsed part of the current period.
    const elapsed = listDates(start, today < end ? today : end);
    const total = agg(elapsed);
    const previousTotal = agg(listDates(prevStart, addDays(prevStart, elapsed.length - 1)));
    const letters = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const bars = listDates(start, end).map((d) => ({
      date: d,
      label: q.range === 'month' ? String(Number(d.slice(8))) : letters[weekday(d)]!,
      value: byDate.get(d) ?? 0,
      isToday: d === today,
    }));

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
      metric: q.metric,
      range: q.range,
      total,
      previousTotal,
      changePct: previousTotal > 0 ? ((total - previousTotal) / previousTotal) * 100 : null,
      bars,
      rankHistory,
      personalBests: await personalBests(ctx, user.id),
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

async function personalBests(
  ctx: AppContext,
  userId: string,
): Promise<{ label: string; value: string }[]> {
  const best = async (metric: string) => {
    const [r] = await ctx.db
      .select({ v: max(dailyMetrics.value) })
      .from(dailyMetrics)
      .where(and(eq(dailyMetrics.userId, userId), eq(dailyMetrics.metric, metric)));
    return r?.v ?? null;
  };
  const [steps, distance] = await Promise.all([best('steps'), best('distance')]);

  // Longest run of consecutive days with 10k+ steps.
  const days = await ctx.db
    .select({ date: dailyMetrics.date })
    .from(dailyMetrics)
    .where(
      and(
        eq(dailyMetrics.userId, userId),
        eq(dailyMetrics.metric, 'steps'),
        gte(dailyMetrics.value, 10_000),
      ),
    )
    .orderBy(asc(dailyMetrics.date));
  let streak = 0;
  let run = 0;
  let prev: string | null = null;
  for (const { date } of days) {
    run = prev && addDays(prev, 1) === date ? run + 1 : 1;
    streak = Math.max(streak, run);
    prev = date;
  }
  const [wins] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(challengeParticipants)
    .where(and(eq(challengeParticipants.userId, userId), eq(challengeParticipants.finalRank, 1)));

  return [
    { label: 'Best distance day', value: distance != null ? `${distance.toFixed(1)} km` : '–' },
    {
      label: 'Best step day',
      value: steps != null ? Math.round(steps).toLocaleString('en-US') : '–',
    },
    { label: '10k-step streak', value: `${streak} ${streak === 1 ? 'day' : 'days'}` },
    { label: 'Challenges won', value: `${wins?.n ?? 0} ${wins?.n === 1 ? 'win' : 'wins'}` },
  ];
}
