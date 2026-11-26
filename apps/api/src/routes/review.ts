/**
 * Month / year in review (yours only) and the calendar heatmap on profiles.
 */
import {
  heatmapQuerySchema,
  type HeatmapResponse,
  type Review,
  type ReviewList,
} from '@gauntlet/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest } from '../context.js';
import { getHeatmap } from '../services/heatmap.js';
import { listReviews, reviewFor } from '../services/review.js';

export function reviewRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireUser(ctx) };

  /** Which months and years have a review (the ones with any data). */
  app.get('/api/me/reviews', auth, async (req): Promise<ReviewList> =>
    listReviews(ctx, req.userId),
  );

  /** One month ("2026-11") or year ("2026"). Always your own: there is no way to ask for anyone else's. */
  app.get<{ Params: { period: string } }>(
    '/api/me/review/:period',
    auth,
    async (req): Promise<Review> => {
      const review = await reviewFor(ctx, req.userId, req.params.period);
      if (!review) throw badRequest('That is not a month or a year, try 2026-11 or 2026.');
      return review;
    },
  );

  /** A year of one daily number. Your own, or someone's who shares their stats. */
  app.get<{ Params: { id: string } }>(
    '/api/users/:id/heatmap',
    auth,
    async (req): Promise<HeatmapResponse> => {
      const { metric, year } = heatmapQuerySchema.parse(req.query);
      return getHeatmap(ctx, req.userId, req.params.id, metric, year);
    },
  );
}
