import {
  addDays,
  createChallengeSchema,
  daysBetween,
  isCustomMetric,
  metricDef,
  respondChallengeSchema,
  todayIn,
  validateRules,
  type ChallengeResult,
  type ChallengeStatus,
  type MetricKey,
} from '@gauntlet/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest, forbidden, notFound } from '../context.js';
import { challengeParticipants, challenges, feedEvents } from '../db/schema.js';
import {
  assertCanView,
  challengeStatus,
  computeChallengeStandings,
  getChallenge,
  getParticipants,
  listForUser,
  loadDetail,
} from '../services/challenges.js';
import { friendIds } from '../services/friends.js';
import { syncUser } from '../services/sync.js';
import {
  getUser,
  getUsers,
  isValidTimeZone,
  sparkyToken,
  toPublicUser,
} from '../services/users.js';

const MAX_DAYS = 366;

export function challengeRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireUser(ctx) };

  app.get<{ Querystring: { status?: ChallengeStatus } }>('/api/challenges', auth, async (req) => {
    const all = await listForUser(ctx, req.userId);
    return req.query.status ? all.filter((c) => c.status === req.query.status) : all;
  });

  app.post('/api/challenges', auth, async (req, reply) => {
    const body = createChallengeSchema.parse(req.body);
    if (!isValidTimeZone(body.timezone)) throw badRequest('Unknown time zone');
    if (daysBetween(body.startDate, body.endDate) + 1 > MAX_DAYS)
      throw badRequest('Challenges can last at most a year');
    const today = todayIn(body.timezone, ctx.now());
    if (body.endDate < today) throw badRequest('That challenge would already be over');
    if (body.startDate < addDays(today, -30))
      throw badRequest('Start date can be at most 30 days ago');

    let metric: MetricKey = body.metric;
    let custom: { label: string; unit: string | null } | null = null;
    let aggregate: 'sum' | 'avg';
    let lowerIsBetter: boolean;
    if (isCustomMetric(metric)) {
      // Custom categories are per user in SparkyFitness; challenges match them by name.
      const me = await getUser(ctx, req.userId);
      const cats = await ctx.sparky.customCategories(sparkyToken(ctx, me));
      const cat = cats.find((c) => c.id === body.custom!.categoryId);
      if (!cat) throw badRequest('That custom metric was not found in SparkyFitness');
      metric = `custom:${cat.name.toLowerCase()}`;
      custom = { label: body.custom!.label, unit: body.custom!.unit ?? null };
      aggregate = body.custom!.aggregate;
      lowerIsBetter = body.custom!.lowerIsBetter;
    } else {
      const def = metricDef(metric);
      aggregate = def.aggregate;
      lowerIsBetter = def.lowerIsBetter;
    }
    const problem = validateRules({ scoring: body.scoring, aggregate, goal: body.goal });
    if (problem) throw badRequest(problem);

    const friends = new Set(await friendIds(ctx, req.userId));
    const invitees = [...new Set(body.inviteUserIds)].filter((id) => id !== req.userId);
    const notFriends = invitees.filter((id) => !friends.has(id));
    if (notFriends.length)
      throw badRequest('You can only invite friends. Share the challenge link with anyone else.');

    const id = await ctx.db.transaction(async (tx) => {
      const [ch] = await tx
        .insert(challenges)
        .values({
          name: body.name,
          metric,
          customLabel: custom?.label ?? null,
          customUnit: custom?.unit ?? null,
          aggregate,
          lowerIsBetter,
          scoring: body.scoring,
          goal: body.goal ?? null,
          startDate: body.startDate,
          endDate: body.endDate,
          timezone: body.timezone,
          createdBy: req.userId,
        })
        .returning({ id: challenges.id });
      await tx.insert(challengeParticipants).values([
        { challengeId: ch!.id, userId: req.userId, state: 'joined' as const },
        ...invitees.map((userId) => ({
          challengeId: ch!.id,
          userId,
          state: 'invited' as const,
          invitedBy: req.userId,
        })),
      ]);
      await tx.insert(feedEvents).values({
        actorId: req.userId,
        challengeId: ch!.id,
        kind: 'challenge_created',
        payload: {},
      });
      return ch!.id;
    });
    // Pull the data the new challenge needs (custom metrics, older start dates).
    void syncUser(ctx, req.userId).catch(() => undefined);
    reply.code(201);
    return loadDetail(ctx, id, req.userId);
  });

  app.get<{ Params: { id: string } }>('/api/challenges/:id', auth, async (req) =>
    loadDetail(ctx, uuid(req.params.id), req.userId),
  );

  app.post<{ Params: { id: string } }>('/api/challenges/:id/respond', auth, async (req) => {
    const { accept } = respondChallengeSchema.parse(req.body);
    const ch = await getChallenge(ctx, uuid(req.params.id));
    const parts = await assertCanView(ctx, ch, req.userId);
    const mine = parts.find((p) => p.userId === req.userId)!;
    if (challengeStatus(ctx, ch) === 'completed') throw badRequest('That challenge is over');
    if (mine.state !== 'joined' || !accept) {
      await ctx.db
        .update(challengeParticipants)
        .set({ state: accept ? 'joined' : 'declined' })
        .where(
          and(
            eq(challengeParticipants.challengeId, ch.id),
            eq(challengeParticipants.userId, req.userId),
          ),
        );
      if (accept) {
        await ctx.db
          .insert(feedEvents)
          .values({ actorId: req.userId, challengeId: ch.id, kind: 'joined', payload: {} });
        void syncUser(ctx, req.userId).catch(() => undefined);
      }
    }
    return loadDetail(ctx, ch.id, req.userId).catch(() => ({ ok: true }));
  });

  app.post<{ Params: { id: string } }>('/api/challenges/:id/invite', auth, async (req) => {
    const { userIds } = z
      .object({ userIds: z.array(z.string().uuid()).min(1).max(50) })
      .parse(req.body);
    const ch = await getChallenge(ctx, uuid(req.params.id));
    const parts = await assertCanView(ctx, ch, req.userId);
    if (parts.find((p) => p.userId === req.userId)?.state !== 'joined')
      throw forbidden('Join the challenge first');
    if (challengeStatus(ctx, ch) === 'completed') throw badRequest('That challenge is over');
    const friends = new Set(await friendIds(ctx, req.userId));
    const fresh = userIds.filter((id) => friends.has(id) && !parts.some((p) => p.userId === id));
    if (fresh.length) {
      await ctx.db
        .insert(challengeParticipants)
        .values(
          fresh.map((userId) => ({
            challengeId: ch.id,
            userId,
            state: 'invited' as const,
            invitedBy: req.userId,
          })),
        )
        .onConflictDoNothing();
    }
    return loadDetail(ctx, ch.id, req.userId);
  });

  app.post<{ Params: { id: string } }>('/api/challenges/:id/leave', auth, async (req) => {
    const ch = await getChallenge(ctx, uuid(req.params.id));
    await assertCanView(ctx, ch, req.userId);
    await ctx.db
      .update(challengeParticipants)
      .set({ state: 'declined' })
      .where(
        and(
          eq(challengeParticipants.challengeId, ch.id),
          eq(challengeParticipants.userId, req.userId),
        ),
      );
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/challenges/:id', auth, async (req) => {
    const ch = await getChallenge(ctx, uuid(req.params.id));
    if (ch.createdBy !== req.userId) throw forbidden('Only the creator can delete a challenge');
    const others = (await getParticipants(ctx, ch.id)).filter(
      (p) => p.userId !== req.userId && p.state === 'joined',
    );
    if (challengeStatus(ctx, ch) !== 'upcoming' && others.length) {
      throw badRequest('Others have joined and it has started. Leave it instead.');
    }
    await ctx.db.delete(challenges).where(eq(challenges.id, ch.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/challenges/:id/rematch', auth, async (req, reply) => {
    const ch = await getChallenge(ctx, uuid(req.params.id));
    const parts = await assertCanView(ctx, ch, req.userId);
    if (challengeStatus(ctx, ch) !== 'completed')
      throw badRequest('Rematch is available once the challenge ends');
    const start = addDays(todayIn(ch.timezone, ctx.now()), 1);
    const end = addDays(start, daysBetween(ch.startDate, ch.endDate));
    const others = parts
      .filter((p) => p.state === 'joined' && p.userId !== req.userId)
      .map((p) => p.userId);
    const id = await ctx.db.transaction(async (tx) => {
      const [copy] = await tx
        .insert(challenges)
        .values({
          name: ch.name.startsWith('Rematch: ') ? ch.name : `Rematch: ${ch.name}`.slice(0, 60),
          metric: ch.metric,
          customLabel: ch.customLabel,
          customUnit: ch.customUnit,
          aggregate: ch.aggregate,
          lowerIsBetter: ch.lowerIsBetter,
          scoring: ch.scoring,
          goal: ch.goal,
          startDate: start,
          endDate: end,
          timezone: ch.timezone,
          createdBy: req.userId,
          rematchOf: ch.id,
        })
        .returning({ id: challenges.id });
      await tx.insert(challengeParticipants).values([
        { challengeId: copy!.id, userId: req.userId, state: 'joined' as const },
        ...others.map((userId) => ({
          challengeId: copy!.id,
          userId,
          state: 'invited' as const,
          invitedBy: req.userId,
        })),
      ]);
      await tx.insert(feedEvents).values({
        actorId: req.userId,
        challengeId: copy!.id,
        kind: 'challenge_created',
        payload: { rematchOf: ch.id },
      });
      return copy!.id;
    });
    reply.code(201);
    return loadDetail(ctx, id, req.userId);
  });

  app.get<{ Params: { id: string } }>(
    '/api/challenges/:id/result',
    auth,
    async (req): Promise<ChallengeResult> => {
      const detail = await loadDetail(ctx, uuid(req.params.id), req.userId);
      const ch = await getChallenge(ctx, detail.id);
      const parts = await getParticipants(ctx, ch.id);
      const { bestDays, standings } = await computeChallengeStandings(ctx, ch, parts);
      const mine = detail.standings.find((s) => s.isMe);
      const winnerRow = detail.standings.find((s) => s.rank === 1 && s.score != null);
      const usersById = await getUsers(ctx, winnerRow ? [winnerRow.user.id] : []);
      const winner = winnerRow ? usersById.get(winnerRow.user.id) : undefined;
      return {
        challenge: detail,
        me: mine
          ? {
              rank: mine.rank,
              score: mine.score,
              bestDay: bestDays.get(req.userId) ?? null,
              daysWithData: standings.find((s) => s.userId === req.userId)?.daysWithData ?? 0,
            }
          : null,
        winner: winner ? toPublicUser(winner) : null,
      };
    },
  );
}

function uuid(id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Challenge not found');
  return id;
}
