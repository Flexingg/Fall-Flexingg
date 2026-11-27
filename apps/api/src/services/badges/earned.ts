/**
 * Earned rows as people read them: the real day a tier was earned, how, and a link to the challenge
 * behind it. Shared by a badge's history and the timeline so they never disagree.
 *
 * A live earn happened the day it was recorded. A backfilled one (launch, publish, history import)
 * was recorded on the backfill day, so it carries the day the threshold was really crossed in its
 * context; that is used when it is a real date and not later than the backfill day itself.
 */
import { localDate, ruleTiers, type BadgeRule } from '@gauntlet/shared';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { challengeParticipants, challenges, type userBadges } from '../../db/schema.js';
import { howEarned, validDay, type Prefs } from './wording.js';

type EarnedRow = Pick<
  typeof userBadges.$inferSelect,
  'tier' | 'earnedAt' | 'backfilled' | 'context'
>;

/** The day this tier was really earned (the owner's own calendar day). */
export function earnedDay(row: EarnedRow, ownerZone: string): string {
  const recorded = localDate(row.earnedAt, ownerZone);
  if (!row.backfilled) return recorded;
  const claimed = validDay(row.context.date);
  return claimed && claimed <= recorded ? claimed : recorded;
}

/** Can this viewer open the challenge (public, or they are in it)? Missing challenges can't be opened. */
export async function canSeeChallenge(ctx: AppContext, viewerId: string, challengeId: string) {
  const [row] = await ctx.db
    .select({ vis: challenges.visibility })
    .from(challenges)
    .where(eq(challenges.id, challengeId));
  if (!row) return false;
  if (row.vis === 'public') return true;
  const [mine] = await ctx.db
    .select({ s: challengeParticipants.state })
    .from(challengeParticipants)
    .where(
      and(
        eq(challengeParticipants.challengeId, challengeId),
        eq(challengeParticipants.userId, viewerId),
      ),
    );
  return !!mine && mine.s !== 'declined';
}

export interface EarnView {
  context: Record<string, unknown>;
  how: string | null;
  to: string | null;
}

/** Remembers who may see which challenge for the length of one request. */
export function challengeAccess(ctx: AppContext, viewerId: string) {
  const seen = new Map<string, boolean>();
  return async (challengeId: string) => {
    if (!seen.has(challengeId))
      seen.set(challengeId, await canSeeChallenge(ctx, viewerId, challengeId));
    return seen.get(challengeId)!;
  };
}

/**
 * The context to show, how it was earned and where to go. Someone else's earn never leaks the name
 * of a private challenge the viewer isn't in (own earns keep the name, but only link what opens).
 */
export async function describeEarn(
  canSee: (challengeId: string) => Promise<boolean>,
  opts: { own: boolean; rule: BadgeRule; row: EarnedRow; prefs: Prefs; thisYear: string },
): Promise<EarnView> {
  let context = opts.row.context;
  let to: string | null = null;
  if (typeof context.challengeId === 'string') {
    if (await canSee(context.challengeId)) to = `/c/${context.challengeId}`;
    else if (!opts.own) {
      const { challengeId: _id, challengeName: _name, ...rest } = context;
      context = rest;
    }
  }
  const tiers = ruleTiers(opts.rule).length;
  const how =
    opts.row.tier >= 1 && opts.row.tier <= tiers
      ? howEarned({
          rule: opts.rule,
          tier: opts.row.tier,
          context,
          prefs: opts.prefs,
          thisYear: opts.thisYear,
        })
      : null;
  return { context, how, to };
}
