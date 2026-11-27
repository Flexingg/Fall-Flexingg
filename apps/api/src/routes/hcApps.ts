/**
 * GET/PUT /api/me/hc-apps: which Health Connect apps count for each stat (see shared/hcApps.ts).
 * Owner only. Like the source order (/api/me/source-priority) the demo account may use it: it
 * only stores a preference and reaches nothing outside the sample data.
 */
import { hcAppOrderSchema, type HcAppsResponse } from '@gauntlet/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest } from '../context.js';
import { buildHcApps, saveHcAppOrder } from '../services/hcApps.js';

const putBody = z.object({ order: hcAppOrderSchema });

export function hcAppRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireUser(ctx) };

  app.get('/api/me/hc-apps', auth, async (req): Promise<HcAppsResponse> =>
    buildHcApps(ctx, req.userId),
  );

  app.put(
    '/api/me/hc-apps',
    { ...auth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req): Promise<HcAppsResponse> => {
      const body = putBody.safeParse(req.body);
      if (!body.success) throw badRequest('That app choice is not valid', 'bad_order');
      return saveHcAppOrder(ctx, req.userId, body.data.order);
    },
  );
}
