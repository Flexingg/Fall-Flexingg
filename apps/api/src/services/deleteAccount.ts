/**
 * Delete a Gauntlet account (the person deleting their own, or an admin removing one). Revokes the
 * API key Gauntlet holds in SparkyFitness (their SparkyFitness data is untouched), signs them out
 * everywhere, then removes the row; everything that belongs to them goes with it.
 *
 * One thing must not go with them: a challenge they created that other people are in. Its creator
 * column cascades, so before deleting we hand each such challenge to the longest-standing joined
 * participant. Challenges nobody else has joined (solo, or only pending invites) are deleted.
 */
import { and, asc, eq, ne } from 'drizzle-orm';
import { revokeAllRefreshTokens } from '../auth.js';
import type { AppContext } from '../context.js';
import { challengeParticipants, challenges, users } from '../db/schema.js';
import { getUser, sparkyToken } from './users.js';

export interface DeleteResult {
  /** Challenges that moved to a new creator, so they survive. */
  transferred: number;
}

export async function deleteAccount(ctx: AppContext, userId: string): Promise<DeleteResult> {
  const user = await getUser(ctx, userId);
  if (user.sparkyKeyId && user.sparkyKeyEnc && user.keyStatus === 'active') {
    // A key can delete itself, which revokes Gauntlet's access.
    await ctx.sparky.deleteApiKey(sparkyToken(ctx, user), user.sparkyKeyId).catch(() => undefined);
  }
  await revokeAllRefreshTokens(ctx, userId);
  return ctx.db.transaction(async (tx) => {
    let transferred = 0;
    const created = await tx
      .select({ id: challenges.id })
      .from(challenges)
      .where(eq(challenges.createdBy, userId));
    for (const { id } of created) {
      const [heir] = await tx
        .select({ userId: challengeParticipants.userId })
        .from(challengeParticipants)
        .where(
          and(
            eq(challengeParticipants.challengeId, id),
            eq(challengeParticipants.state, 'joined'),
            ne(challengeParticipants.userId, userId),
          ),
        )
        .orderBy(asc(challengeParticipants.createdAt), asc(challengeParticipants.userId))
        .limit(1);
      if (!heir) continue;
      await tx.update(challenges).set({ createdBy: heir.userId }).where(eq(challenges.id, id));
      transferred++;
    }
    await tx.delete(users).where(eq(users.id, userId));
    return { transferred };
  });
}
