/**
 * Social triggers for badges, kept in one place instead of threaded through every route: after a
 * successful reaction, comment, challenge created/joined/answered/rematched, invite or friend
 * accepted, or side bet settled, the people it affects get a (social-rules-only) badge check in the
 * background. Registered before the routes so it sees all of them; never slows or fails a request.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import { challengeParticipants, invites, users } from '../../db/schema.js';
import { checkBadges } from './engine.js';
import { runInBackground } from './tasks.js';

type Who = (ctx: AppContext, req: FastifyRequest, status: number) => Promise<string[]>;

const me: Who = async (_ctx, req) => [req.userId];

/** You and whoever invited you to that challenge (their invite just paid off). */
const meAndInviter: Who = async (ctx, req) => {
  const id = (req.params as { id?: string }).id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return [req.userId];
  const [row] = await ctx.db
    .select({ by: challengeParticipants.invitedBy })
    .from(challengeParticipants)
    .where(
      and(eq(challengeParticipants.challengeId, id), eq(challengeParticipants.userId, req.userId)),
    );
  return row?.by ? [req.userId, row.by] : [req.userId];
};

const TRIGGERS: Record<string, Who> = {
  'POST /api/feed/:eventId/reactions': me,
  'POST /api/feed/:eventId/comments': me,
  'POST /api/challenges': me,
  'POST /api/challenges/:id/join': meAndInviter,
  'POST /api/challenges/:id/respond': meAndInviter,
  'POST /api/challenges/:id/rematch': me,
  'POST /api/invites/:code/accept': async (ctx, req) => {
    const code = (req.params as { code: string }).code.toLowerCase();
    const [inv] = await ctx.db
      .select({ owner: invites.ownerId })
      .from(invites)
      .where(eq(invites.code, code));
    return inv ? [req.userId, inv.owner] : [req.userId];
  },
  'POST /api/friends/requests/:userId/accept': async (_ctx, req) => [
    req.userId,
    (req.params as { userId: string }).userId,
  ],
  // A request that was really the answer to one of theirs makes you friends straight away.
  'POST /api/friends/requests': async (ctx, req) => {
    const body = (req.body ?? {}) as { userId?: string; email?: string };
    if (body.userId) return [req.userId, body.userId];
    if (!body.email) return [req.userId];
    const [u] = await ctx.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${body.email.toLowerCase()}`);
    return u ? [req.userId, u.id] : [req.userId];
  },
  // Paying up counts for whoever lost the bet, so check everyone in the challenge.
  'POST /api/challenges/:id/stake/settle': async (ctx, req) => {
    const id = (req.params as { id: string }).id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return [];
    const rows = await ctx.db
      .select({ id: challengeParticipants.userId })
      .from(challengeParticipants)
      .where(
        and(eq(challengeParticipants.challengeId, id), eq(challengeParticipants.state, 'joined')),
      );
    return rows.map((r) => r.id);
  },
};

export function registerBadgeHooks(app: FastifyInstance, ctx: AppContext): void {
  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode >= 300 || !req.userId) return;
    const who = TRIGGERS[`${req.method} ${req.routeOptions.url}`];
    if (!who) return;
    runInBackground(ctx, 'badge check', async () => {
      const ids = [...new Set(await who(ctx, req, reply.statusCode))];
      for (const id of ids) await checkBadges(ctx, id, { reason: 'social' });
    });
  });
}
