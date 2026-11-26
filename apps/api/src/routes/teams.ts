/**
 * The creator's tools for team challenges: move people between teams and shuffle everyone evenly.
 * Both only work until the challenge starts (after that teams are locked for fairness).
 * People pick or switch their own team through join/respond in routes/challenges.ts.
 */
import { moveTeamMembersSchema, shuffleIntoTeams } from '@gauntlet/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest, forbidden, notFound } from '../context.js';
import { challengeParticipants } from '../db/schema.js';
import {
  challengeStatus,
  getChallenge,
  getParticipants,
  loadDetail,
  type ChallengeRow,
} from '../services/challenges.js';
import { getTeams } from '../services/teams.js';

function uuid(id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Challenge not found');
  return id;
}

/** The creator may rearrange teams of a team challenge that hasn't started. */
function assertCanArrange(ctx: AppContext, ch: ChallengeRow, userId: string) {
  if (!ch.teamScoring) throw badRequest('This challenge has no teams.');
  if (ch.createdBy !== userId) throw forbidden('Only the creator can move people between teams');
  if (challengeStatus(ctx, ch) !== 'upcoming')
    throw badRequest('Teams are locked once the challenge starts.', 'teams_locked');
}

export function teamRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireUser(ctx) };

  /** Put these people (already joined) on a team. */
  app.patch<{ Params: { id: string; teamId: string } }>(
    '/api/challenges/:id/teams/:teamId/members',
    auth,
    async (req) => {
      const { userIds } = moveTeamMembersSchema.parse(req.body);
      const ch = await getChallenge(ctx, uuid(req.params.id));
      assertCanArrange(ctx, ch, req.userId);
      const team = (await getTeams(ctx, ch.id)).find((t) => t.id === req.params.teamId);
      if (!team) throw notFound('Team not found');
      const joined = new Set(
        (await getParticipants(ctx, ch.id))
          .filter((p) => p.state === 'joined')
          .map((p) => p.userId),
      );
      if (userIds.some((id) => !joined.has(id)))
        throw badRequest('Only people who joined can be moved.');
      await ctx.db
        .update(challengeParticipants)
        .set({ teamId: team.id })
        .where(
          and(
            eq(challengeParticipants.challengeId, ch.id),
            inArray(challengeParticipants.userId, userIds),
          ),
        );
      return loadDetail(ctx, ch.id, req.userId);
    },
  );

  /** Deal everyone who joined into the teams at random, as evenly as possible. */
  app.post<{ Params: { id: string } }>('/api/challenges/:id/teams/shuffle', auth, async (req) => {
    const ch = await getChallenge(ctx, uuid(req.params.id));
    assertCanArrange(ctx, ch, req.userId);
    const teams = await getTeams(ctx, ch.id);
    const joined = (await getParticipants(ctx, ch.id)).filter((p) => p.state === 'joined');
    const plan = shuffleIntoTeams(
      joined.map((p) => p.userId),
      teams.length,
    );
    await ctx.db.transaction(async (tx) => {
      for (const [userId, idx] of plan)
        await tx
          .update(challengeParticipants)
          .set({ teamId: teams[idx]!.id })
          .where(
            and(
              eq(challengeParticipants.challengeId, ch.id),
              eq(challengeParticipants.userId, userId),
            ),
          );
    });
    return loadDetail(ctx, ch.id, req.userId);
  });
}
