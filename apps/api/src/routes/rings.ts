/**
 * The Today rings a person set up (which three stats, and the daily goal for each) and the day
 * screen that shows every stat for one day. Own data only: both read the signed-in person's rows.
 * The demo account may change its rings (harmless, and it lets visitors try the feature).
 */
import {
  buildDay,
  DAY_HISTORY_DAYS,
  addDays,
  isDateString,
  ringConfigSchema,
  ringsOf,
  todayIn,
  type DayResponse,
  type RingConfig,
} from '@gauntlet/shared';
import { and, eq, gte, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest } from '../context.js';
import { dailyMetrics, users } from '../db/schema.js';
import { getUser } from '../services/users.js';

const dayQuery = z.object({ date: z.string().optional() });

export function ringRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireUser(ctx) };

  app.get('/api/me/rings', auth, async (req): Promise<{ rings: RingConfig }> => {
    const user = await getUser(ctx, req.userId);
    return { rings: ringsOf(user.ringConfig) };
  });

  app.put('/api/me/rings', auth, async (req): Promise<{ rings: RingConfig }> => {
    // Either { rings: [...] } or the bare list.
    const raw = req.body as { rings?: unknown } | unknown[] | null;
    const body = ringConfigSchema.safeParse(Array.isArray(raw) ? raw : raw?.rings);
    if (!body.success)
      throw badRequest(body.error.issues[0]?.message ?? 'Those rings are not valid', 'bad_rings');
    const rings = body.data as RingConfig;
    await ctx.db.update(users).set({ ringConfig: rings }).where(eq(users.id, req.userId));
    return { rings };
  });

  /** Every stat for one day (default today), up to 90 days back. */
  app.get('/api/me/day', auth, async (req): Promise<DayResponse> => {
    const { date: asked } = dayQuery.parse(req.query ?? {});
    const user = await getUser(ctx, req.userId);
    const today = todayIn(user.timezone, ctx.now());
    const date = asked ?? today;
    if (!isDateString(date)) throw badRequest('That date is not valid', 'bad_date');
    if (date > today || date < addDays(today, -DAY_HISTORY_DAYS))
      throw badRequest('That day is out of range', 'bad_date');
    const rows = await ctx.db
      .select({ date: dailyMetrics.date, metric: dailyMetrics.metric, value: dailyMetrics.value })
      .from(dailyMetrics)
      .where(
        and(
          eq(dailyMetrics.userId, user.id),
          gte(dailyMetrics.date, date),
          lte(dailyMetrics.date, date),
        ),
      );
    return buildDay({ rows, date, today, config: ringsOf(user.ringConfig) });
  });
}
