/**
 * GET /api/me/day/stat?date=YYYY-MM-DD&metric=steps: where one of your own daily stats came from
 * (the long-press sheet on the day screen). There is no way to ask for anyone else's: it always
 * reads the signed-in person's rows. Read only, so the demo account can use it too.
 */
import {
  addDays,
  DAY_HISTORY_DAYS,
  isDateString,
  statMeta,
  todayIn,
  type StatSourceResponse,
} from '@gauntlet/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest } from '../context.js';
import { buildStatSource } from '../services/statSource.js';
import { getUser } from '../services/users.js';

const query = z.object({ date: z.string(), metric: z.string().max(200) });

export function statSourceRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get(
    '/api/me/day/stat',
    { preHandler: requireUser(ctx) },
    async (req): Promise<StatSourceResponse> => {
      const q = query.safeParse(req.query ?? {});
      if (!q.success) throw badRequest('Say which day and stat', 'bad_params');
      const { date, metric } = q.data;
      const user = await getUser(ctx, req.userId);
      const today = todayIn(user.timezone, ctx.now());
      if (!isDateString(date)) throw badRequest('That date is not valid', 'bad_date');
      if (date > today || date < addDays(today, -DAY_HISTORY_DAYS))
        throw badRequest('That day is out of range', 'bad_date');
      if (!statMeta(metric)) throw badRequest('That stat is not valid', 'bad_metric');
      return buildStatSource(ctx, user.id, date, metric);
    },
  );
}
