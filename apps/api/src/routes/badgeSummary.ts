/**
 * GET /api/badges/summary: your level, XP, badge count and newest badge in a few cheap queries, for
 * the Today header and card. (The full catalog works out progress for every badge; this doesn't.)
 */
import { levelFor, ruleTiers, tierName, type BadgeIcon, type BadgeSummary } from '@gauntlet/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { badgeDefinitions, userBadges } from '../db/schema.js';
import { getUser } from '../services/users.js';

export function badgeSummaryRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireUser(ctx) };

  app.get('/api/badges/summary', auth, async (req): Promise<BadgeSummary> => {
    const user = await getUser(ctx, req.userId);
    const [counts] = await ctx.db
      .select({
        earned: sql<number>`count(distinct ${userBadges.badgeKey})::int`,
        unseen: sql<number>`count(*) filter (where ${userBadges.seenAt} is null)::int`,
      })
      .from(userBadges)
      .where(eq(userBadges.userId, user.id));
    const [row] = await ctx.db
      .select({ b: userBadges, d: badgeDefinitions })
      .from(userBadges)
      .innerJoin(badgeDefinitions, eq(badgeDefinitions.key, userBadges.badgeKey))
      .where(and(eq(userBadges.userId, user.id)))
      .orderBy(desc(userBadges.earnedAt), desc(userBadges.tier))
      .limit(1);
    const count = row ? ruleTiers(row.d.rule).length : 0;
    return {
      level: levelFor(user.badgeXp),
      earnedCount: counts?.earned ?? 0,
      unseenCount: counts?.unseen ?? 0,
      latest: row
        ? {
            key: row.d.key,
            name: row.d.name,
            icon: row.d.icon as BadgeIcon,
            imageUrl: row.d.imageUrl,
            tier: row.b.tier,
            tierName: tierName(row.b.tier, count),
            earnedAt: row.b.earnedAt.toISOString(),
          }
        : null,
    };
  });
}
