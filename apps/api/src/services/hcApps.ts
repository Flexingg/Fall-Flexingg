/**
 * Which Health Connect apps count, per stat (0.18): the person's saved order (users.hc_app_order)
 * and the apps the phone has seen writing each stat lately (health_origins), so the chooser has
 * something to offer. The order itself is applied on the phone when it reads Health Connect, so a
 * change only shows in the numbers after the next sync. Owner only: always the caller's own rows.
 */
import {
  addDays,
  summariseSeen,
  todayIn,
  type HcAppOrder,
  type HcAppsResponse,
} from '@gauntlet/shared';
import { and, eq, gte } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { healthOrigins, users } from '../db/schema.js';
import { getUser } from './users.js';

const SEEN_DAYS = 30;

/** One list per stat, no repeated app, nothing for a stat whose list ended up empty. */
export function cleanOrder(order: HcAppOrder): HcAppOrder {
  const out: HcAppOrder = {};
  for (const [metric, list] of Object.entries(order)) {
    const packages = [...new Set(list)];
    if (packages.length) out[metric] = packages;
  }
  return out;
}

export async function buildHcApps(ctx: AppContext, userId: string): Promise<HcAppsResponse> {
  const user = await getUser(ctx, userId);
  const since = addDays(todayIn(user.timezone, ctx.now()), -SEEN_DAYS);
  const rows = await ctx.db
    .select()
    .from(healthOrigins)
    .where(and(eq(healthOrigins.userId, userId), gte(healthOrigins.date, since)));

  const seen = summariseSeen(rows);
  return { order: user.hcAppOrder ?? {}, seen };
}

export async function saveHcAppOrder(
  ctx: AppContext,
  userId: string,
  order: HcAppOrder,
): Promise<HcAppsResponse> {
  await ctx.db
    .update(users)
    .set({ hcAppOrder: cleanOrder(order) })
    .where(eq(users.id, userId));
  return buildHcApps(ctx, userId);
}
