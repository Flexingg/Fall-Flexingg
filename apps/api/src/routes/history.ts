import { IDLE_HISTORY, startHistorySchema, type HistoryStatus } from '@gauntlet/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import {
  cancelHistoryImport,
  getHistoryStatus,
  startHistoryImport,
} from '../services/historyImport.js';
import { demoBlocked, getUser } from '../services/users.js';

/**
 * Import older data (up to five years). One job per person, running on the server; the app starts
 * it, polls its status and can cancel it. The demo account has no SparkyFitness behind it, so it
 * can't start one (reading the idle status is harmless).
 */
export function historyRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireUser(ctx) };
  const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: '10 minutes' } } });

  const noDemo = async (userId: string) => {
    if ((await getUser(ctx, userId)).isDemo) throw demoBlocked();
  };

  app.get('/api/me/history-import', auth, async (req): Promise<HistoryStatus> => {
    const user = await getUser(ctx, req.userId);
    if (user.isDemo) return IDLE_HISTORY;
    return getHistoryStatus(ctx, req.userId);
  });

  app.post(
    '/api/me/history-import',
    { ...auth, ...limit(40) },
    async (req): Promise<HistoryStatus> => {
      await noDemo(req.userId);
      return startHistoryImport(ctx, req.userId, startHistorySchema.parse(req.body ?? {}));
    },
  );

  app.delete('/api/me/history-import', auth, async (req): Promise<HistoryStatus> => {
    await noDemo(req.userId);
    return cancelHistoryImport(ctx, req.userId);
  });
}
