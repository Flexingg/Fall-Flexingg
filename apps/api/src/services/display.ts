/**
 * How each person likes numbers, units and times written (metric/imperial, 12/24-hour, number
 * format). They live inside the existing users.notification_prefs JSON column under a "display"
 * key, so no migration is needed; the notification-prefs route only merges the kind keys it knows
 * and leaves this alone. Notification texts, the recap and the feed read these so they match what
 * the person's own screens show.
 */
import {
  DEFAULT_DISPLAY,
  resolveDisplay,
  normalizeLocale,
  type ClockFormat,
  type DisplayPrefs,
  type UnitSystem,
} from '@gauntlet/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { users } from '../db/schema.js';
import type { UserRow } from './users.js';

export interface SavedDisplay {
  units?: UnitSystem;
  clock?: ClockFormat;
  locale?: string;
}

/** What a user row has saved (nothing chosen yet = empty). */
export function savedDisplay(u: Pick<UserRow, 'notificationPrefs'>): SavedDisplay {
  const d = (u.notificationPrefs as { display?: SavedDisplay } | null)?.display;
  return d && typeof d === 'object' ? d : {};
}

/** The display settings to write with, falling back to metric / 12-hour / en-US. */
export function displayOf(u: Pick<UserRow, 'notificationPrefs'> | null | undefined): DisplayPrefs {
  return u ? resolveDisplay(savedDisplay(u)) : DEFAULT_DISPLAY;
}

export async function displayFor(ctx: AppContext, userId: string): Promise<DisplayPrefs> {
  const [u] = await ctx.db
    .select({ notificationPrefs: users.notificationPrefs })
    .from(users)
    .where(eq(users.id, userId));
  return displayOf(u);
}

export async function displayForMany(
  ctx: AppContext,
  userIds: string[],
): Promise<Map<string, DisplayPrefs>> {
  const out = new Map<string, DisplayPrefs>();
  if (!userIds.length) return out;
  const rows = await ctx.db
    .select({ id: users.id, notificationPrefs: users.notificationPrefs })
    .from(users)
    .where(inArray(users.id, userIds));
  for (const r of rows) out.set(r.id, displayOf(r));
  return out;
}

/** Merge a change into the saved display settings (jsonb || keeps the notification kinds intact). */
export async function saveDisplay(
  ctx: AppContext,
  userId: string,
  patch: SavedDisplay,
): Promise<void> {
  const clean: SavedDisplay = {};
  if (patch.units) clean.units = patch.units;
  if (patch.clock) clean.clock = patch.clock;
  if (patch.locale) clean.locale = normalizeLocale(patch.locale);
  if (!Object.keys(clean).length) return;
  const [u] = await ctx.db
    .select({ notificationPrefs: users.notificationPrefs })
    .from(users)
    .where(eq(users.id, userId));
  const merged = { ...savedDisplay(u ?? { notificationPrefs: {} }), ...clean };
  await ctx.db
    .update(users)
    .set({
      notificationPrefs: sql`${users.notificationPrefs} || ${JSON.stringify({ display: merged })}::jsonb`,
    })
    .where(eq(users.id, userId));
}
