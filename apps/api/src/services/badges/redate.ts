/**
 * One-time fix-up for rows the launch/publish backfills wrote before the evaluator could say when a
 * threshold was really crossed: their context.date is the backfill day. Re-evaluate each
 * (person, badge) that has backfilled rows and move context to the real crossing when that is an
 * earlier, valid day. Tier, earnedAt and XP are never touched and nothing is deleted.
 *
 * Runs once (server_state `badge_redate_v1`), under an advisory lock so two API instances starting
 * together don't both do it. A failure on one person/badge is logged and skipped; the run still
 * counts as done so a permanently odd row can't make every start re-run it.
 */
import { localDate, ruleTiers } from '@gauntlet/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { badgeDefinitions, serverState, userBadges, users } from '../../db/schema.js';
import { evalDefOf } from './engine.js';
import { evaluateRule } from './evaluate.js';
import { validDay } from './wording.js';

export const REDATE_KEY = 'badge_redate_v1';
const LOCK_ID = 7_340_114;

/** Returns how many rows were moved, or null when it had already run (or another instance is on it). */
export async function redateBackfilledBadges(ctx: AppContext): Promise<number | null> {
  return ctx.db.transaction(async (tx) => {
    const [lock] = await tx.execute<{ ok: boolean }>(
      sql`select pg_try_advisory_xact_lock(${LOCK_ID}) as ok`,
    );
    if (!lock?.ok) return null;
    const [done] = await ctx.db
      .select({ key: serverState.key })
      .from(serverState)
      .where(eq(serverState.key, REDATE_KEY));
    if (done) return null;
    const moved = await run(ctx);
    await ctx.db
      .insert(serverState)
      .values({
        key: REDATE_KEY,
        value: { at: ctx.now().toISOString(), moved },
        updatedAt: ctx.now(),
      })
      .onConflictDoNothing();
    ctx.log.info({ moved }, 'badge earn dates corrected');
    return moved;
  });
}

async function run(ctx: AppContext): Promise<number> {
  const pairs = await ctx.db
    .selectDistinct({ userId: userBadges.userId, key: userBadges.badgeKey })
    .from(userBadges)
    .where(eq(userBadges.backfilled, true));
  const defs = new Map((await ctx.db.select().from(badgeDefinitions)).map((d) => [d.key, d]));
  const zones = new Map(
    (await ctx.db.select({ id: users.id, tz: users.timezone, demo: users.isDemo }).from(users)).map(
      (u) => [u.id, u],
    ),
  );
  let moved = 0;
  for (const { userId, key } of pairs) {
    const d = defs.get(key);
    const u = zones.get(userId);
    if (!d || !u || u.demo) continue;
    try {
      const ev = await evaluateRule(ctx, { id: userId, timezone: u.tz }, evalDefOf(d));
      const tiers = ruleTiers(d.rule);
      const rows = await ctx.db
        .select()
        .from(userBadges)
        .where(
          and(
            eq(userBadges.userId, userId),
            eq(userBadges.badgeKey, key),
            eq(userBadges.backfilled, true),
          ),
        );
      for (const row of rows) {
        const threshold = tiers[row.tier - 1];
        // The data may have changed since (deleted days): only trust a threshold still reached.
        if (threshold == null || ev.value < threshold) continue;
        const recorded = localDate(row.earnedAt, u.tz);
        const current = validDay(row.context.date);
        const was = current && current <= recorded ? current : recorded;
        const context = await ev.contextFor(threshold);
        const date = validDay(context.date);
        if (!date || date >= was) continue;
        await ctx.db
          .update(userBadges)
          .set({ context })
          .where(
            and(
              eq(userBadges.userId, userId),
              eq(userBadges.badgeKey, key),
              eq(userBadges.tier, row.tier),
            ),
          );
        moved++;
      }
    } catch (err) {
      ctx.log.warn({ err: String(err), userId, key }, 'badge redate failed');
    }
  }
  return moved;
}
