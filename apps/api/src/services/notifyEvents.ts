/**
 * The existing happenings that tell someone something: friend requests, challenge invites, losing
 * the lead and challenges ending. Each is a thin wrapper that words the message and calls notify();
 * the callers only say what happened.
 */
import { ordinal } from '@gauntlet/shared';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { challengeParticipants, notifications } from '../db/schema.js';
import { notify } from './notify.js';
import { getUsers, shortName } from './users.js';

const firstName = (name: string) => shortName(name).split(' ')[0]!;

/** Someone asked to be friends. */
export async function notifyFriendRequest(ctx: AppContext, fromId: string, toId: string) {
  const from = (await getUsers(ctx, [fromId])).get(fromId);
  if (!from) return;
  await notify(ctx, toId, {
    kind: 'friend_request',
    title: 'New friend request',
    body: `${shortName(from.displayName)} wants to be friends.`,
    url: '/friends',
    payload: { fromId },
  });
}

/** People were invited to a challenge. */
export async function notifyChallengeInvites(
  ctx: AppContext,
  challenge: { id: string; name: string; solo?: unknown },
  inviterId: string,
  inviteeIds: string[],
) {
  if (challenge.solo) return;
  const inviter = (await getUsers(ctx, [inviterId])).get(inviterId);
  if (!inviter) return;
  for (const userId of inviteeIds) {
    if (userId === inviterId) continue;
    await notify(ctx, userId, {
      kind: 'challenge_invite',
      title: 'Challenge invite',
      body: `${shortName(inviter.displayName)} invited you to ${challenge.name}.`,
      url: `/c/${challenge.id}`,
      payload: { challengeId: challenge.id, inviterId },
    });
  }
}

/** At most one lead-change alert per person per challenge in this long. */
const LEAD_CHANGE_QUIET = sql`now() - interval '6 hours'`;

/** The new leader passed the old one: tell the person who lost the lead (not more than every 6 h). */
export async function notifyLeadChange(
  ctx: AppContext,
  challenge: { id: string; name: string },
  newLeaderId: string,
  overtakenIds: string[],
) {
  if (!overtakenIds.length) return;
  const leader = (await getUsers(ctx, [newLeaderId])).get(newLeaderId);
  if (!leader) return;
  for (const userId of overtakenIds) {
    if (userId === newLeaderId) continue;
    const [joined] = await ctx.db
      .select({ state: challengeParticipants.state })
      .from(challengeParticipants)
      .where(
        and(
          eq(challengeParticipants.challengeId, challenge.id),
          eq(challengeParticipants.userId, userId),
        ),
      );
    if (joined?.state !== 'joined') continue;
    const [already] = await ctx.db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.kind, 'lead_change'),
          sql`${notifications.payload}->>'challengeId' = ${challenge.id}`,
          gt(notifications.createdAt, LEAD_CHANGE_QUIET),
        ),
      )
      .limit(1);
    if (already) continue;
    await notify(ctx, userId, {
      kind: 'lead_change',
      title: 'You lost the lead',
      body: `${firstName(leader.displayName)} just took the lead in ${challenge.name}.`,
      url: `/c/${challenge.id}`,
      payload: { challengeId: challenge.id, leaderId: newLeaderId },
    });
  }
}

/** A challenge ended: everyone who was in it hears where they finished. */
export async function notifyChallengeFinished(
  ctx: AppContext,
  challenge: { id: string; name: string },
  results: { userId: string; rank: number; score: number | null }[],
) {
  const scored = results.filter((r) => r.score != null);
  for (const r of results) {
    const body =
      r.score == null
        ? 'It finished before any of your data counted.'
        : r.rank === 1
          ? scored.length > 1
            ? `You won! First place out of ${scored.length}.`
            : 'You finished first.'
          : `You finished ${ordinal(r.rank)} out of ${scored.length}.`;
    await notify(ctx, r.userId, {
      kind: 'challenge_finished',
      title: `${challenge.name} is over`,
      body,
      url: `/c/${challenge.id}/result`,
      payload: { challengeId: challenge.id, rank: r.rank },
    });
  }
}
