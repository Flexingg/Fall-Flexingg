import {
  formatCompact,
  formatQuantity,
  metricDef,
  REACTIONS,
  type FeedEvent,
  type MetricKey,
} from '@gauntlet/shared';
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import {
  challengeParticipants,
  challenges,
  feedComments,
  feedEvents,
  feedReactions,
} from '../db/schema.js';
import { displayFor } from './display.js';
import { friendIds } from './friends.js';
import { recordBadge } from './records.js';
import { getUsers, shortName, toPublicUser } from './users.js';

/**
 * Which feed events a person may see: everything in challenges they have joined, plus the
 * challenge-free activity of themselves and their friends. Reactions and comments reuse this.
 */
async function visibleTo(ctx: AppContext, userId: string): Promise<SQL> {
  const people = [userId, ...(await friendIds(ctx, userId))];
  const myChallenges = (
    await ctx.db
      .select({ id: challengeParticipants.challengeId })
      .from(challengeParticipants)
      .where(
        and(eq(challengeParticipants.userId, userId), eq(challengeParticipants.state, 'joined')),
      )
  ).map((r) => r.id);

  const own = and(isNull(feedEvents.challengeId), inArray(feedEvents.actorId, people))!;
  return myChallenges.length ? or(inArray(feedEvents.challengeId, myChallenges), own)! : own;
}

/** The event (just who did it) if this person may see it, else null. */
export async function canSeeEvent(
  ctx: AppContext,
  viewerId: string,
  eventId: string,
): Promise<{ id: string; actorId: string } | null> {
  const [row] = await ctx.db
    .select({ id: feedEvents.id, actorId: feedEvents.actorId })
    .from(feedEvents)
    .where(and(eq(feedEvents.id, eventId), await visibleTo(ctx, viewerId)));
  return row ?? null;
}

/** One event as the viewer sees it, or null when they can't see it. */
export async function feedEventFor(
  ctx: AppContext,
  viewerId: string,
  eventId: string,
): Promise<FeedEvent | null> {
  return (await feedFor(ctx, viewerId, 1, eventId))[0] ?? null;
}

export async function feedFor(
  ctx: AppContext,
  userId: string,
  limit = 30,
  onlyEventId?: string,
): Promise<FeedEvent[]> {
  const visible = onlyEventId
    ? and(await visibleTo(ctx, userId), eq(feedEvents.id, onlyEventId))
    : await visibleTo(ctx, userId);

  const rows = await ctx.db
    .select({
      e: feedEvents,
      chName: challenges.name,
      chMetric: challenges.metric,
      chLabel: challenges.customLabel,
      chUnit: challenges.customUnit,
    })
    .from(feedEvents)
    .leftJoin(challenges, eq(challenges.id, feedEvents.challengeId))
    .where(visible)
    .orderBy(desc(feedEvents.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));

  const prefs = await displayFor(ctx, userId);
  const usersById = await getUsers(
    ctx,
    rows.map((r) => r.e.actorId),
  );
  const ids = rows.map((r) => r.e.id);
  const reactionRows = ids.length
    ? await ctx.db
        .select({
          eventId: feedReactions.eventId,
          emoji: feedReactions.emoji,
          count: sql<number>`count(*)::int`,
          mine: sql<boolean>`bool_or(${feedReactions.userId} = ${userId})`,
        })
        .from(feedReactions)
        .where(inArray(feedReactions.eventId, ids))
        .groupBy(feedReactions.eventId, feedReactions.emoji)
    : [];
  const commentRows = ids.length
    ? await ctx.db
        .select({ eventId: feedComments.eventId, count: sql<number>`count(*)::int` })
        .from(feedComments)
        .where(inArray(feedComments.eventId, ids))
        .groupBy(feedComments.eventId)
    : [];
  const commentCounts = new Map(commentRows.map((r) => [r.eventId, r.count]));

  return rows.flatMap(({ e, chName, chMetric, chLabel, chUnit }) => {
    const actor = usersById.get(e.actorId);
    if (!actor) return [];
    const name = shortName(actor.displayName).split(' ')[0]!;
    const challenge = e.challengeId && chName ? { id: e.challengeId, name: chName } : null;
    const p = e.payload as Record<string, unknown>;
    let text = '';
    let badge: string | null = null;
    switch (e.kind) {
      case 'progress': {
        const metric = (p.metric as MetricKey | undefined) ?? (chMetric as MetricKey);
        const def = metricDef(metric, {
          label: chLabel ?? metric,
          unit: chUnit ?? undefined,
          aggregate: 'sum',
          lowerIsBetter: false,
        });
        const delta = Number(p.delta ?? 0);
        const amount = formatQuantity(delta, def.unit, def.decimals, prefs, false);
        badge = `+${metric === 'steps' ? formatCompact(delta, 1, prefs) : amount}`;
        text =
          metric === 'distance'
            ? `${name} covered ${formatQuantity(delta, 'km', def.decimals, prefs)}`
            : metric === 'steps'
              ? `${name} hit ${formatCompact(delta, 1, prefs)} steps`
              : metric === 'workouts'
                ? `${name} logged ${delta === 1 ? 'a workout' : `${amount} workouts`}`
                : metric === 'active_minutes'
                  ? `${name} logged ${amount} active min`
                  : metric === 'active_calories'
                    ? `${name} burned ${amount} kcal`
                    : `${name} logged ${formatQuantity(delta, def.unit, def.decimals, prefs)} ${def.label.toLowerCase()}`;
        break;
      }
      case 'took_lead':
        text = `${name} took the lead${challenge ? ` in ${challenge.name}` : ''}`;
        break;
      case 'challenge_won':
        text =
          typeof p.teamName === 'string'
            ? `${name}'s team ${p.teamName} won ${challenge?.name ?? 'a challenge'}`
            : `${name} won ${challenge?.name ?? 'a challenge'}`;
        badge = '1st';
        break;
      case 'joined':
        text = `${name} joined ${challenge?.name ?? 'a challenge'}`;
        break;
      case 'challenge_created':
        text = `${name} started ${challenge?.name ?? 'a challenge'}`;
        break;
      case 'personal_record':
        text = `${name} set a new ${typeof p.label === 'string' ? p.label : 'personal record'}`;
        badge = recordBadge(p, prefs);
        break;
      default:
        text = `${name} was active`;
    }
    return [
      {
        id: e.id,
        kind: e.kind as FeedEvent['kind'],
        actor: toPublicUser(actor),
        challenge,
        text,
        badge,
        // Which app the data came from is only shown if the person allows it.
        source: actor.shareWorkoutDetails && typeof p.source === 'string' ? p.source : null,
        createdAt: e.createdAt.toISOString(),
        reactions: REACTIONS.flatMap((emoji) => {
          const r = reactionRows.find((x) => x.eventId === e.id && x.emoji === emoji);
          return r ? [{ emoji, count: r.count, mine: r.mine }] : [];
        }),
        commentCount: commentCounts.get(e.id) ?? 0,
      },
    ];
  });
}
