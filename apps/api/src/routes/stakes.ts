/**
 * Marking a side bet "paid up". Either the creator or a winner can do it once the challenge is over
 * (and take it back). It only flips a date: Gauntlet never moves money.
 */
import { settleStakeSchema } from '@gauntlet/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest, forbidden, notFound } from '../context.js';
import { challenges } from '../db/schema.js';
import { getChallenge, loadDetail } from '../services/challenges.js';

export function stakeRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireUser(ctx) };

  app.post<{ Params: { id: string } }>('/api/challenges/:id/stake/settle', auth, async (req) => {
    const { settled } = settleStakeSchema.parse(req.body ?? {});
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw notFound('Challenge not found');
    // loadDetail enforces that the viewer can see the challenge at all.
    const detail = await loadDetail(ctx, req.params.id, req.userId);
    const ch = await getChallenge(ctx, detail.id);
    if (!ch.stake) throw badRequest('This challenge has no side bet.');
    if (!detail.stakeInfo) throw badRequest('The side bet can be settled once the challenge ends.');
    if (!detail.stakeInfo.canSettle)
      throw forbidden('Only the winner or the creator can mark a side bet as paid up');
    await ctx.db
      .update(challenges)
      .set({ stakeSettledAt: settled ? (ch.stakeSettledAt ?? ctx.now()) : null })
      .where(eq(challenges.id, ch.id));
    return loadDetail(ctx, ch.id, req.userId);
  });
}
