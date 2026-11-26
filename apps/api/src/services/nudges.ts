/**
 * Nudges: a friendly "your move" ping to a friend or challenge-mate. Who may be nudged and how
 * often is decided here so the route and the "can I nudge?" check can't disagree.
 */
import { NUDGE_DAILY_MAX, NUDGE_PAIR_HOURS, type NudgeStatus } from '@gauntlet/shared';
import { aliasedTable, and, desc, eq, gt } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { challengeParticipants, challenges, nudges } from '../db/schema.js';
import { challengeStatus } from './challenges.js';
import { friendshipWith } from './privacy.js';

const HOUR = 3_600_000;

/** Both people have joined this challenge and it is running. */
export async function bothInRunningChallenge(
  ctx: AppContext,
  challengeId: string,
  a: string,
  b: string,
): Promise<boolean> {
  const [ch] = await ctx.db.select().from(challenges).where(eq(challenges.id, challengeId));
  if (!ch || challengeStatus(ctx, ch) !== 'active') return false;
  const rows = await ctx.db
    .select({ userId: challengeParticipants.userId })
    .from(challengeParticipants)
    .where(
      and(
        eq(challengeParticipants.challengeId, challengeId),
        eq(challengeParticipants.state, 'joined'),
      ),
    );
  const ids = new Set(rows.map((r) => r.userId));
  return ids.has(a) && ids.has(b);
}

/** A friend, or someone in a running challenge with you. */
export async function mayNudge(ctx: AppContext, from: string, to: string): Promise<boolean> {
  if (from === to) return false;
  if ((await friendshipWith(ctx, from, to)) === 'friends') return true;
  const mine = challengeParticipants;
  const theirs = aliasedTable(challengeParticipants, 'theirs');
  const shared = await ctx.db
    .select({ id: mine.challengeId })
    .from(mine)
    .innerJoin(theirs, eq(theirs.challengeId, mine.challengeId))
    .where(
      and(
        eq(mine.userId, from),
        eq(theirs.userId, to),
        eq(mine.state, 'joined'),
        eq(theirs.state, 'joined'),
      ),
    );
  for (const s of shared) if (await bothInRunningChallenge(ctx, s.id, from, to)) return true;
  return false;
}

/** When the limits next allow a nudge from `from` to `to`; null if they allow it now. */
export async function nudgeRetryAt(
  ctx: AppContext,
  from: string,
  to: string,
): Promise<{ at: Date; reason: 'pair' | 'daily' } | null> {
  const now = ctx.now();
  const sent = await ctx.db
    .select({ toUserId: nudges.toUserId, createdAt: nudges.createdAt })
    .from(nudges)
    .where(
      and(eq(nudges.fromUserId, from), gt(nudges.createdAt, new Date(now.getTime() - 24 * HOUR))),
    )
    .orderBy(desc(nudges.createdAt));
  const last = sent.find((n) => n.toUserId === to);
  if (last) {
    const at = new Date(last.createdAt.getTime() + NUDGE_PAIR_HOURS * HOUR);
    if (at > now) return { at, reason: 'pair' };
  }
  if (sent.length >= NUDGE_DAILY_MAX) {
    // The daily window frees up when the oldest of the last ten falls out of it.
    const oldest = sent[NUDGE_DAILY_MAX - 1]!;
    return { at: new Date(oldest.createdAt.getTime() + 24 * HOUR), reason: 'daily' };
  }
  return null;
}

export async function nudgeStatus(ctx: AppContext, from: string, to: string): Promise<NudgeStatus> {
  if (!(await mayNudge(ctx, from, to))) return { canNudge: false, retryAt: null };
  const wait = await nudgeRetryAt(ctx, from, to);
  return { canNudge: !wait, retryAt: wait ? wait.at.toISOString() : null };
}
