/**
 * Which Health Connect apps wrote each day's stat, as the phone reported it (0.17). One row per
 * user, day and stat; a re-send replaces the row, so the latest read is what's kept. Owner only.
 */
import { addDays, isHcOriginMetric, type HcOrigin } from '@gauntlet/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { badRequest } from '../context.js';
import { healthOrigins } from '../db/schema.js';

/** How far back an origin may be (Health Connect itself keeps far less unless the person allows it). */
const MAX_AGE_DAYS = 731;
const CHUNK = 500;

export type OriginRow = typeof healthOrigins.$inferSelect;

/** Throws a 400 for a stat nobody reads or a date that can't be real. */
export function checkOrigins(ctx: AppContext, origins: HcOrigin[]): void {
  const today = ctx.now().toISOString().slice(0, 10);
  const oldest = addDays(today, -MAX_AGE_DAYS);
  const newest = addDays(today, 1);
  for (const o of origins) {
    if (!isHcOriginMetric(o.metric)) throw badRequest(`Unknown stat: ${o.metric}`);
    if (Number.isNaN(Date.parse(`${o.date}T00:00:00Z`))) throw badRequest(`Bad date: ${o.date}`);
    if (o.date < oldest) throw badRequest(`Date too old: ${o.date}`);
    if (o.date > newest) throw badRequest(`Date in the future: ${o.date}`);
  }
}

/** Store the origins, replacing any already stored for the same day and stat. */
export async function saveHealthOrigins(
  ctx: AppContext,
  userId: string,
  origins: HcOrigin[],
): Promise<number> {
  checkOrigins(ctx, origins);
  // One row per day and stat even if the phone sent a pair twice (the last one wins).
  const latest = new Map(origins.map((o) => [`${o.date}|${o.metric}`, o]));
  const rows = [...latest.values()].map((o) => ({
    userId,
    date: o.date,
    metric: o.metric,
    apps: o.apps,
    counted: o.counted,
    capped: o.capped,
    updatedAt: ctx.now(),
  }));
  await ctx.db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      await tx
        .insert(healthOrigins)
        .values(rows.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: [healthOrigins.userId, healthOrigins.date, healthOrigins.metric],
          set: {
            apps: sql`excluded.apps`,
            counted: sql`excluded.counted`,
            capped: sql`excluded.capped`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }
  });
  return rows.length;
}

/** What the phone reported for this person's day and stat, or null. */
export async function originFor(
  ctx: AppContext,
  userId: string,
  date: string,
  metric: string,
): Promise<OriginRow | null> {
  const [row] = await ctx.db
    .select()
    .from(healthOrigins)
    .where(
      and(
        eq(healthOrigins.userId, userId),
        eq(healthOrigins.date, date),
        eq(healthOrigins.metric, metric),
      ),
    )
    .limit(1);
  return row ?? null;
}
