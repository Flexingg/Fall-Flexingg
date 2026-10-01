import { friendRequestSchema, type Friend, type FriendRequest, type FriendsResponse } from '@gauntlet/shared';
import { and, eq, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest, HttpError, notFound } from '../context.js';
import { friendships, users } from '../db/schema.js';
import { listForUser, loadDetail } from '../services/challenges.js';
import { pair } from '../services/friends.js';
import { getUsers, toPublicUser } from '../services/users.js';

const ONLINE_WINDOW_MS = 6 * 3_600_000;

export function friendRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireUser(ctx) };

  app.get('/api/friends', auth, async (req): Promise<FriendsResponse> => {
    const me = req.userId;
    const rows = await ctx.db
      .select()
      .from(friendships)
      .where(or(eq(friendships.userLow, me), eq(friendships.userHigh, me)));
    const other = (r: (typeof rows)[number]) => (r.userLow === me ? r.userHigh : r.userLow);
    const usersById = await getUsers(ctx, rows.map(other));
    const challenges = (await listForUser(ctx, me)).filter((c) => c.status === 'active' && c.myState === 'joined');

    const friends: Friend[] = [];
    const requests: FriendRequest[] = [];
    for (const r of rows) {
      const u = usersById.get(other(r));
      if (!u) continue;
      if (r.status === 'pending') {
        requests.push({ id: u.id, user: toPublicUser(u), direction: r.requestedBy === me ? 'outgoing' : 'incoming', createdAt: r.createdAt.toISOString() });
        continue;
      }
      friends.push({
        ...toPublicUser(u),
        lastSyncedAt: u.lastSyncedAt?.toISOString() ?? null,
        status: null,
        sharedRank: null,
        online: !!u.lastSyncedAt && ctx.now().getTime() - u.lastSyncedAt.getTime() < ONLINE_WINDOW_MS,
      });
    }
    // Show what friends are competing in with me, and where they stand.
    for (const c of challenges) {
      const detail = await loadDetail(ctx, c.id, me);
      for (const row of detail.standings) {
        const f = friends.find((x) => x.id === row.user.id);
        if (f && f.status == null) {
          f.status = `${c.metricLabel} · ${c.name}`;
          f.sharedRank = row.score != null ? row.rank : null;
        }
      }
    }
    friends.sort((a, b) => (a.sharedRank ?? 99) - (b.sharedRank ?? 99) || a.displayName.localeCompare(b.displayName));
    return { friends, requests };
  });

  app.post('/api/friends/requests', auth, async (req) => {
    const { email } = friendRequestSchema.parse(req.body);
    const [target] = await ctx.db.select().from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
    if (!target) {
      throw new HttpError(404, "They're not on Gauntlet yet. Send them your invite link instead.", 'not_on_gauntlet');
    }
    if (target.id === req.userId) throw badRequest("That's you.");
    const p = pair(req.userId, target.id);
    const [existing] = await ctx.db.select().from(friendships).where(and(eq(friendships.userLow, p.userLow), eq(friendships.userHigh, p.userHigh)));
    if (existing?.status === 'accepted') return { status: 'friends' };
    if (existing && existing.requestedBy !== req.userId) {
      await ctx.db.update(friendships).set({ status: 'accepted', acceptedAt: ctx.now() }).where(and(eq(friendships.userLow, p.userLow), eq(friendships.userHigh, p.userHigh)));
      return { status: 'friends' };
    }
    if (!existing) await ctx.db.insert(friendships).values({ ...p, requestedBy: req.userId, status: 'pending' });
    return { status: 'requested' };
  });

  app.post<{ Params: { userId: string } }>('/api/friends/requests/:userId/accept', auth, async (req) => {
    const p = pair(req.userId, req.params.userId);
    const [row] = await ctx.db
      .update(friendships)
      .set({ status: 'accepted', acceptedAt: ctx.now() })
      .where(
        and(
          eq(friendships.userLow, p.userLow),
          eq(friendships.userHigh, p.userHigh),
          eq(friendships.status, 'pending'),
          eq(friendships.requestedBy, req.params.userId),
        ),
      )
      .returning();
    if (!row) throw notFound('No pending request from that person');
    return { status: 'friends' };
  });

  /** Unfriend, decline an incoming request, or cancel an outgoing one. */
  app.delete<{ Params: { userId: string } }>('/api/friends/:userId', auth, async (req) => {
    const p = pair(req.userId, req.params.userId);
    await ctx.db.delete(friendships).where(and(eq(friendships.userLow, p.userLow), eq(friendships.userHigh, p.userHigh)));
    return { ok: true };
  });
}
