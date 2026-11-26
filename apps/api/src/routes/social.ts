/**
 * Social routes: reactions and comments on feed items, and nudges. Everything on a feed item is
 * gated by the same visibility rule as the feed itself (canSeeEvent), so a person can never reach
 * an item they could not see, and the demo account stays inside its own cast.
 */
import {
  commentBodySchema,
  nudgeBodySchema,
  reactionBodySchema,
  type FeedComment,
  type NudgeStatus,
} from '@gauntlet/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest, forbidden, HttpError, notFound } from '../context.js';
import { feedComments, feedEvents, feedReactions, notifications, nudges } from '../db/schema.js';
import { getChallenge } from '../services/challenges.js';
import { canSeeEvent, feedEventFor } from '../services/feed.js';
import { notify } from '../services/notify.js';
import { bothInRunningChallenge, mayNudge, nudgeRetryAt, nudgeStatus } from '../services/nudges.js';
import { getUser, getUsers, shortName, toPublicUser } from '../services/users.js';

const first = (name: string) => shortName(name).split(' ')[0]!;

export function socialRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireUser(ctx) };
  const commentLimit = { ...auth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  async function visibleEvent(viewerId: string, eventId: string) {
    // A malformed id can't match anything; answer like any other unseen item.
    if (!/^[0-9a-f-]{36}$/i.test(eventId)) throw notFound('Activity not found');
    const ev = await canSeeEvent(ctx, viewerId, eventId);
    if (!ev) throw notFound('Activity not found');
    return ev;
  }

  app.get<{ Params: { eventId: string } }>('/api/feed/:eventId', auth, async (req) => {
    await visibleEvent(req.userId, req.params.eventId);
    const item = await feedEventFor(ctx, req.userId, req.params.eventId);
    if (!item) throw notFound('Activity not found');
    return item;
  });

  // ---- Reactions ----

  app.post<{ Params: { eventId: string } }>('/api/feed/:eventId/reactions', auth, async (req) => {
    const { emoji } = reactionBodySchema.parse(req.body);
    const ev = await visibleEvent(req.userId, req.params.eventId);
    await ctx.db
      .insert(feedReactions)
      .values({ eventId: ev.id, userId: req.userId, emoji, createdAt: ctx.now() })
      .onConflictDoNothing();
    if (ev.actorId !== req.userId) await notifyReaction(ev, req.userId, emoji);
    return (await feedEventFor(ctx, req.userId, ev.id))!;
  });

  app.delete<{ Params: { eventId: string; emoji: string } }>(
    '/api/feed/:eventId/reactions/:emoji',
    auth,
    async (req) => {
      const emoji = reactionBodySchema.parse({ emoji: req.params.emoji }).emoji;
      const ev = await visibleEvent(req.userId, req.params.eventId);
      await ctx.db
        .delete(feedReactions)
        .where(
          and(
            eq(feedReactions.eventId, ev.id),
            eq(feedReactions.userId, req.userId),
            eq(feedReactions.emoji, emoji),
          ),
        );
      return (await feedEventFor(ctx, req.userId, ev.id))!;
    },
  );

  /** One notification per person per item, so toggling a reaction on and off never spams. */
  async function notifyReaction(
    ev: { id: string; actorId: string },
    reactorId: string,
    emoji: string,
  ) {
    const [already] = await ctx.db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, ev.actorId),
          eq(notifications.kind, 'reaction'),
          sql`${notifications.payload}->>'eventId' = ${ev.id}`,
          sql`${notifications.payload}->>'reactorId' = ${reactorId}`,
        ),
      )
      .limit(1);
    if (already) return;
    const [reactor, item] = await Promise.all([
      getUser(ctx, reactorId),
      feedEventFor(ctx, ev.actorId, ev.id),
    ]);
    await notify(ctx, ev.actorId, {
      kind: 'reaction',
      title: `${first(reactor.displayName)} reacted ${emoji}`,
      body: item ? yourWords(item.text) : 'To your activity',
      url: `/feed/${ev.id}`,
      payload: { eventId: ev.id, reactorId, emoji },
    });
  }

  // ---- Comments ----

  app.get<{ Params: { eventId: string } }>('/api/feed/:eventId/comments', auth, async (req) => {
    const ev = await visibleEvent(req.userId, req.params.eventId);
    const rows = await ctx.db
      .select()
      .from(feedComments)
      .where(eq(feedComments.eventId, ev.id))
      .orderBy(asc(feedComments.createdAt));
    const people = await getUsers(
      ctx,
      rows.map((r) => r.userId),
    );
    return rows.flatMap((r): FeedComment[] => {
      const u = people.get(r.userId);
      if (!u) return [];
      return [
        {
          id: r.id,
          eventId: r.eventId,
          user: toPublicUser(u),
          body: r.body,
          createdAt: r.createdAt.toISOString(),
          canDelete: r.userId === req.userId || ev.actorId === req.userId,
        },
      ];
    });
  });

  app.post<{ Params: { eventId: string } }>(
    '/api/feed/:eventId/comments',
    commentLimit,
    async (req): Promise<FeedComment> => {
      const { body } = commentBodySchema.parse(req.body);
      const ev = await visibleEvent(req.userId, req.params.eventId);
      const [row] = await ctx.db
        .insert(feedComments)
        .values({ eventId: ev.id, userId: req.userId, body, createdAt: ctx.now() })
        .returning();
      const me = await getUser(ctx, req.userId);
      if (ev.actorId !== req.userId) {
        await notify(ctx, ev.actorId, {
          kind: 'comment',
          title: `${first(me.displayName)} commented`,
          body: body.length > 100 ? `${body.slice(0, 99)}…` : body,
          url: `/feed/${ev.id}`,
          payload: { eventId: ev.id, commentId: row!.id, commenterId: req.userId },
        });
      }
      return {
        id: row!.id,
        eventId: ev.id,
        user: toPublicUser(me),
        body,
        createdAt: row!.createdAt.toISOString(),
        canDelete: true,
      };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/comments/:id', auth, async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw notFound('Comment not found');
    const [row] = await ctx.db
      .select({ c: feedComments, actorId: feedEvents.actorId })
      .from(feedComments)
      .innerJoin(feedEvents, eq(feedEvents.id, feedComments.eventId))
      .where(eq(feedComments.id, req.params.id));
    if (!row) throw notFound('Comment not found');
    if (row.c.userId !== req.userId && row.actorId !== req.userId) {
      // People who can't see the item shouldn't learn the comment exists.
      if (!(await canSeeEvent(ctx, req.userId, row.c.eventId))) throw notFound('Comment not found');
      throw forbidden('Only the author or the person who posted this can delete a comment');
    }
    await ctx.db.delete(feedComments).where(eq(feedComments.id, row.c.id));
    return reply.code(204).send();
  });

  // ---- Nudges ----

  app.get<{ Params: { userId: string } }>(
    '/api/nudges/status/:userId',
    auth,
    async (req): Promise<NudgeStatus> => {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.userId)) return { canNudge: false, retryAt: null };
      return nudgeStatus(ctx, req.userId, req.params.userId);
    },
  );

  app.post('/api/nudges', auth, async (req, reply) => {
    const { userId: to, challengeId } = nudgeBodySchema.parse(req.body);
    const from = req.userId;
    if (to === from) throw badRequest("You can't nudge yourself");
    if (!(await mayNudge(ctx, from, to)))
      throw new HttpError(
        403,
        'You can nudge friends and people in a running challenge with you',
        'forbidden',
      );
    let challengeName: string | null = null;
    if (challengeId) {
      if (!(await bothInRunningChallenge(ctx, challengeId, from, to)))
        throw badRequest("You're not both in that challenge, or it isn't running");
      challengeName = (await getChallenge(ctx, challengeId)).name;
    }
    const wait = await nudgeRetryAt(ctx, from, to);
    if (wait) {
      const them = first((await getUser(ctx, to)).displayName);
      return reply.code(429).send({
        error:
          wait.reason === 'pair'
            ? `You already nudged ${them}. Try again later.`
            : "You've sent a lot of nudges today. Try again later.",
        code: 'nudge_limit',
        retryAt: wait.at.toISOString(),
      });
    }
    await ctx.db.insert(nudges).values({
      fromUserId: from,
      toUserId: to,
      challengeId: challengeId ?? null,
      createdAt: ctx.now(),
    });
    const me = await getUser(ctx, from);
    await notify(ctx, to, {
      kind: 'nudge',
      title: `${first(me.displayName)} nudged you`,
      body: challengeName ? `Your move in ${challengeName}` : 'Time to move!',
      url: challengeId ? `/c/${challengeId}` : '/',
      payload: { fromUserId: from, challengeId: challengeId ?? null },
    });
    const next = await nudgeRetryAt(ctx, from, to);
    return { ok: true, retryAt: next ? next.at.toISOString() : null };
  });
}

/** "Maya covered 10.2 km" -> "You covered 10.2 km": the item as its owner would say it. */
function yourWords(text: string): string {
  const rest = text.split(' ').slice(1).join(' ');
  return rest ? `You ${rest}` : text;
}
