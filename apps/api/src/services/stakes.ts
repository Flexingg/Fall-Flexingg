/**
 * Side bets and rematch series, server side. A stake is plain text; who owes it comes from the final
 * standings (last place, or the last-place team(s) in a team challenge). The series record walks a
 * chain of rematches (via `rematchOf`) and counts wins from finalized results only.
 */
import {
  stakeOutcome,
  tallySeries,
  type ChallengeTeam,
  type ChallengeStatus,
  type RematchSeries,
  type StakeInfo,
} from '@gauntlet/shared';
import { eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { challengeParticipants, challenges } from '../db/schema.js';
import type { ChallengeRow, ParticipantRow } from './challenges.js';
import { getUsers, toPublicUser, type UserRow } from './users.js';

/** The longest chain of rematches we will walk. */
const MAX_CHAIN = 50;

/** Winners and losers (as user ids) from each person's rank, or from team ranks in a team challenge. */
export function outcomeOf(args: {
  teams: ChallengeTeam[] | null | undefined;
  people: { userId: string; rank: number; score: number | null }[];
}): { winners: string[]; losers: string[] } {
  if (args.teams?.length) {
    const o = stakeOutcome(args.teams.map((t) => ({ id: t.id, rank: t.rank, score: t.score })));
    const members = (ids: string[]) =>
      args.teams!.filter((t) => ids.includes(t.id)).flatMap((t) => t.memberIds);
    return { winners: members(o.winners), losers: members(o.losers) };
  }
  const o = stakeOutcome(args.people.map((p) => ({ id: p.userId, rank: p.rank, score: p.score })));
  return o;
}

/** Who owes the side bet and whether the viewer may mark it paid up. Null until it is over. */
export function buildStakeInfo(args: {
  ch: ChallengeRow;
  status: ChallengeStatus;
  teams: ChallengeTeam[] | null | undefined;
  people: { userId: string; rank: number; score: number | null }[];
  usersById: Map<string, UserRow>;
  viewerId: string;
}): StakeInfo | null {
  const { ch, status, usersById, viewerId } = args;
  if (!ch.stake || ch.solo || status !== 'completed') return null;
  const { winners, losers } = outcomeOf(args);
  const named = (ids: string[]) =>
    ids.flatMap((id) => {
      const u = usersById.get(id);
      return u ? [toPublicUser(u)] : [];
    });
  return {
    settledAt: ch.stakeSettledAt?.toISOString() ?? null,
    owedBy: named(losers),
    owedTo: named(winners),
    canSettle: ch.createdBy === viewerId || winners.includes(viewerId),
  };
}

/**
 * The running record across a chain of rematches the viewer can see: follow `rematchOf` back to the
 * first challenge, then every rematch forward. Null for solo challenges, challenges that were never
 * rematched, and chains with no finished round yet.
 */
export async function loadRematchSeries(
  ctx: AppContext,
  ch: ChallengeRow,
  viewerId: string,
): Promise<RematchSeries | null> {
  if (ch.solo) return null;
  let root = ch;
  const seenUp = new Set([ch.id]);
  while (root.rematchOf && seenUp.size < MAX_CHAIN) {
    const [parent] = await ctx.db
      .select()
      .from(challenges)
      .where(eq(challenges.id, root.rematchOf));
    if (!parent || seenUp.has(parent.id)) break;
    seenUp.add(parent.id);
    root = parent;
  }
  const chain: ChallengeRow[] = [root];
  const depthOf = new Map([[root.id, 1]]);
  let frontier = [root.id];
  while (frontier.length && chain.length < MAX_CHAIN) {
    const kids = await ctx.db
      .select()
      .from(challenges)
      .where(inArray(challenges.rematchOf, frontier))
      .orderBy(challenges.startDate, challenges.createdAt);
    frontier = [];
    for (const k of kids) {
      if (depthOf.has(k.id) || chain.length >= MAX_CHAIN) continue;
      depthOf.set(k.id, (depthOf.get(k.rematchOf!) ?? 1) + 1);
      chain.push(k);
      frontier.push(k.id);
    }
  }
  if (chain.length < 2) return null;

  const parts = await ctx.db
    .select()
    .from(challengeParticipants)
    .where(
      inArray(
        challengeParticipants.challengeId,
        chain.map((c) => c.id),
      ),
    );
  const byChallenge = new Map<string, ParticipantRow[]>();
  for (const p of parts)
    byChallenge.set(p.challengeId, [...(byChallenge.get(p.challengeId) ?? []), p]);

  const rounds = chain
    .filter((row) => {
      if (!row.finalizedAt) return false;
      // Only rounds the viewer could open themselves.
      return (
        row.visibility === 'public' || byChallenge.get(row.id)?.some((p) => p.userId === viewerId)
      );
    })
    .map((row) => {
      const joined = (byChallenge.get(row.id) ?? []).filter((p) => p.state === 'joined');
      return {
        participants: joined.map((p) => p.userId),
        winners: joined
          .filter((p) => p.finalRank === 1 && (p.finalScore != null || !!row.teamScoring))
          .map((p) => p.userId),
      };
    });
  const tally = tallySeries(rounds);
  if (!tally.rounds) return null;
  const usersById = await getUsers(
    ctx,
    tally.entries.map((e) => e.userId),
  );
  return {
    rounds: tally.rounds,
    position: depthOf.get(ch.id) ?? 1,
    total: chain.length,
    entries: tally.entries.flatMap((e) => {
      const u = usersById.get(e.userId);
      return u ? [{ user: toPublicUser(u), wins: e.wins, isMe: e.userId === viewerId }] : [];
    }),
  };
}
