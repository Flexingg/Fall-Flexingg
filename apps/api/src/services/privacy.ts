/**
 * Who can see whom. Private users (the default) are visible only to friends,
 * people with a pending request either way, and people they share a challenge
 * with. Public users are visible to everyone signed in. Nobody else's email or
 * health data is ever shown, only name, handle and challenge totals.
 */
import { initials, type UserCard } from '@gauntlet/shared';
import { aliasedTable, and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { challengeParticipants, friendships, users } from '../db/schema.js';
import { pair } from './friends.js';
import type { UserRow } from './users.js';

type Friendship = UserCard['friendship'];

export async function friendshipWith(
  ctx: AppContext,
  viewerId: string,
  otherId: string,
): Promise<Friendship> {
  if (viewerId === otherId) return 'me';
  const p = pair(viewerId, otherId);
  const [row] = await ctx.db
    .select()
    .from(friendships)
    .where(and(eq(friendships.userLow, p.userLow), eq(friendships.userHigh, p.userHigh)));
  if (!row) return 'none';
  if (row.status === 'accepted') return 'friends';
  return row.requestedBy === viewerId ? 'outgoing' : 'incoming';
}

/** True when both are in (or invited to) the same challenge. */
export async function shareChallenge(ctx: AppContext, a: string, b: string): Promise<boolean> {
  const mine = challengeParticipants;
  const theirs = aliasedTable(challengeParticipants, 'theirs');
  const [row] = await ctx.db
    .select({ id: mine.challengeId })
    .from(mine)
    .innerJoin(theirs, eq(theirs.challengeId, mine.challengeId))
    .where(
      and(
        eq(mine.userId, a),
        eq(theirs.userId, b),
        inArray(mine.state, ['invited', 'joined']),
        inArray(theirs.state, ['invited', 'joined']),
      ),
    )
    .limit(1);
  return !!row;
}

export async function canSeeUser(
  ctx: AppContext,
  viewerId: string,
  target: Pick<UserRow, 'id' | 'visibility'>,
): Promise<boolean> {
  if (target.visibility === 'public' || target.id === viewerId) return true;
  if ((await friendshipWith(ctx, viewerId, target.id)) !== 'none') return true;
  return shareChallenge(ctx, viewerId, target.id);
}

/** Finished challenges played and won, per user. */
export async function challengeTotals(
  ctx: AppContext,
  ids: string[],
): Promise<Map<string, { played: number; won: number }>> {
  const out = new Map(ids.map((id) => [id, { played: 0, won: 0 }]));
  if (!ids.length) return out;
  const rows = await ctx.db
    .select({
      userId: challengeParticipants.userId,
      played: sql<number>`count(*)::int`,
      won: sql<number>`count(*) filter (where ${challengeParticipants.finalRank} = 1)::int`,
    })
    .from(challengeParticipants)
    .where(
      and(
        inArray(challengeParticipants.userId, ids),
        eq(challengeParticipants.state, 'joined'),
        isNotNull(challengeParticipants.finalRank),
      ),
    )
    .groupBy(challengeParticipants.userId);
  for (const r of rows) out.set(r.userId, { played: r.played, won: r.won });
  return out;
}

export async function toCards(
  ctx: AppContext,
  viewerId: string,
  rows: UserRow[],
): Promise<UserCard[]> {
  const ids = rows.map((r) => r.id);
  const totals = await challengeTotals(ctx, ids);
  const rels = ids.length
    ? await ctx.db
        .select()
        .from(friendships)
        .where(
          or(
            and(eq(friendships.userLow, viewerId), inArray(friendships.userHigh, ids)),
            and(eq(friendships.userHigh, viewerId), inArray(friendships.userLow, ids)),
          ),
        )
    : [];
  return rows.map((u) => {
    const rel = rels.find((r) => r.userLow === u.id || r.userHigh === u.id);
    const friendship: Friendship =
      u.id === viewerId
        ? 'me'
        : !rel
          ? 'none'
          : rel.status === 'accepted'
            ? 'friends'
            : rel.requestedBy === viewerId
              ? 'outgoing'
              : 'incoming';
    return {
      id: u.id,
      displayName: u.displayName,
      initials: initials(u.displayName),
      handle: u.handle,
      challenges: totals.get(u.id) ?? { played: 0, won: 0 },
      friendship,
    };
  });
}

/** Public users whose name or handle matches. Never private users. */
export async function searchPublicUsers(
  ctx: AppContext,
  viewerId: string,
  q: string,
): Promise<UserCard[]> {
  const term = q.replace(/^@/, '').toLowerCase();
  const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const prefix = `${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await ctx.db
    .select()
    .from(users)
    .where(
      and(
        eq(users.visibility, 'public'),
        or(sql`lower(${users.displayName}) like ${like}`, sql`${users.handle} like ${prefix}`),
      ),
    )
    .orderBy(
      sql`case when ${users.handle} = ${term} then 0 when lower(${users.displayName}) like ${prefix} then 1 else 2 end`,
      users.displayName,
    )
    .limit(20);
  return toCards(ctx, viewerId, rows);
}
