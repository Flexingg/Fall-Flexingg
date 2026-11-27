/**
 * Badge history over time: one person's timeline of tiers earned (the same privacy as their badges:
 * yourself, or someone visible who shares their stats), and the XP race of you against your friends.
 */
import { XP_RACE_RANGES } from '@gauntlet/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { badgeTargetFor } from '../services/badges/access.js';
import { buildRace, buildTimeline } from '../services/badges/timeline.js';

const timelineQuery = z.object({
  before: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const raceQuery = z.object({ range: z.enum(XP_RACE_RANGES).default('90d') });

export function badgeTimelineRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireUser(ctx) };

  app.get<{ Params: { id: string } }>('/api/users/:id/badges/timeline', auth, async (req) => {
    const target = await badgeTargetFor(ctx, req.userId, req.params.id);
    const q = timelineQuery.parse(req.query ?? {});
    return buildTimeline(ctx, req.userId, target, { before: q.before, limit: q.limit });
  });

  app.get('/api/badges/race', auth, async (req) => {
    const { range } = raceQuery.parse(req.query ?? {});
    return buildRace(ctx, req.userId, range);
  });
}
