/**
 * Stats routes: head-to-head with another person, and workouts (your list, one workout's detail).
 * All read-only; the rules about who sees what live in the services.
 */
import {
  compareQuerySchema,
  workoutDetailQuerySchema,
  workoutsQuerySchema,
  type CompareResponse,
  type WorkoutDetail,
  type WorkoutsResponse,
} from '@gauntlet/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { compareWith } from '../services/compare.js';
import { getWorkout, listOwnWorkouts } from '../services/workouts.js';

export function statsRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireUser(ctx) };
  // Workouts are read live from SparkyFitness, so keep them to a polite rate.
  const live = { ...auth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

  /** You and them over a range, plus your record in challenges you both finished. */
  app.get<{ Params: { id: string } }>(
    '/api/users/:id/compare',
    auth,
    async (req): Promise<CompareResponse> => {
      const { range } = compareQuerySchema.parse(req.query);
      return compareWith(ctx, req.userId, req.params.id, range);
    },
  );

  /** Your own workouts for the last N days (default 30), newest first. */
  app.get('/api/me/workouts', live, async (req): Promise<WorkoutsResponse> => {
    const { days } = workoutsQuerySchema.parse(req.query);
    return listOwnWorkouts(ctx, req.userId, days);
  });

  /** One workout with its sets. Yours, or someone's that Show Events lets you see (?userId=). */
  app.get<{ Params: { id: string } }>(
    '/api/workouts/:id',
    live,
    async (req): Promise<WorkoutDetail> => {
      const { userId } = workoutDetailQuerySchema.parse(req.query);
      return getWorkout(ctx, req.userId, req.params.id, userId);
    },
  );
}
