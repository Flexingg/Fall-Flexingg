import { and, eq, or } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { friendships } from '../db/schema.js';

export function pair(a: string, b: string): { userLow: string; userHigh: string } {
  return a < b ? { userLow: a, userHigh: b } : { userLow: b, userHigh: a };
}

export async function friendIds(ctx: AppContext, userId: string): Promise<string[]> {
  const rows = await ctx.db
    .select()
    .from(friendships)
    .where(
      and(
        eq(friendships.status, 'accepted'),
        or(eq(friendships.userLow, userId), eq(friendships.userHigh, userId)),
      ),
    );
  return rows.map((r) => (r.userLow === userId ? r.userHigh : r.userLow));
}

export async function areFriends(ctx: AppContext, a: string, b: string): Promise<boolean> {
  const p = pair(a, b);
  const [row] = await ctx.db
    .select()
    .from(friendships)
    .where(
      and(
        eq(friendships.userLow, p.userLow),
        eq(friendships.userHigh, p.userHigh),
        eq(friendships.status, 'accepted'),
      ),
    );
  return !!row;
}

/** Make two users friends straight away (used when someone accepts an invite link). */
export async function befriend(ctx: AppContext, a: string, b: string, requestedBy: string) {
  if (a === b) return;
  await ctx.db
    .insert(friendships)
    .values({ ...pair(a, b), requestedBy, status: 'accepted', acceptedAt: ctx.now() })
    .onConflictDoUpdate({
      target: [friendships.userLow, friendships.userHigh],
      set: { status: 'accepted', acceptedAt: ctx.now() },
    });
}
