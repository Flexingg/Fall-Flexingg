import { hcOriginsIngestSchema } from '@gauntlet/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { saveHealthOrigins } from '../services/healthOrigins.js';

/**
 * The phone says which Health Connect apps wrote each day's data (see statSource.ts). Stored for the
 * owner only. The demo account is blocked from every /api/ingest route (demoRouteBlocked).
 */
export function healthOriginRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post(
    '/api/ingest/health-connect/origins',
    { preHandler: requireUser(ctx), bodyLimit: 4 * 1024 * 1024 },
    async (req) => {
      const { origins } = hcOriginsIngestSchema.parse(req.body);
      return { stored: await saveHealthOrigins(ctx, req.userId, origins) };
    },
  );
}
