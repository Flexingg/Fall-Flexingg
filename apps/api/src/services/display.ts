/**
 * How each person likes numbers, units and times written (metric/imperial, 12/24-hour, number
 * format), in users.display_units / display_clock / display_locale. Notification texts, the recap and
 * the feed read these so they match what the person's own screens show.
 */
import {
  DEFAULT_DISPLAY,
  resolveDisplay,
  normalizeLocale,
  type ClockFormat,
  type DisplayPrefs,
  type UnitSystem,
} from '@gauntlet/shared';
import { eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { users } from '../db/schema.js';
import type { UserRow } from './users.js';

export interface SavedDisplay {
  units?: UnitSystem;
  clock?: ClockFormat;
  locale?: string;
}

/** What a user row has saved (nothing chosen yet = empty). */
type DisplayCols = Pick<UserRow, 'displayUnits' | 'displayClock' | 'displayLocale'>;
const cols = {
  displayUnits: users.displayUnits,
  displayClock: users.displayClock,
  displayLocale: users.displayLocale,
};

export function savedDisplay(u: DisplayCols): SavedDisplay {
  const d: SavedDisplay = {};
  if (u.displayUnits) d.units = u.displayUnits;
  if (u.displayClock) d.clock = u.displayClock;
  if (u.displayLocale) d.locale = u.displayLocale;
  return d;
}

/** The display settings to write with, falling back to metric / 12-hour / en-US. */
export function displayOf(u: DisplayCols | null | undefined): DisplayPrefs {
  return u ? resolveDisplay(savedDisplay(u)) : DEFAULT_DISPLAY;
}

export async function displayFor(ctx: AppContext, userId: string): Promise<DisplayPrefs> {
  const [u] = await ctx.db.select(cols).from(users).where(eq(users.id, userId));
  return displayOf(u);
}

export async function displayForMany(
  ctx: AppContext,
  userIds: string[],
): Promise<Map<string, DisplayPrefs>> {
  const out = new Map<string, DisplayPrefs>();
  if (!userIds.length) return out;
  const rows = await ctx.db
    .select({ id: users.id, ...cols })
    .from(users)
    .where(inArray(users.id, userIds));
  for (const r of rows) out.set(r.id, displayOf(r));
  return out;
}

/** Save a change to the display settings (only the fields given). */
export async function saveDisplay(
  ctx: AppContext,
  userId: string,
  patch: SavedDisplay,
): Promise<void> {
  const set: Partial<Record<keyof typeof cols, string>> = {};
  if (patch.units) set.displayUnits = patch.units;
  if (patch.clock) set.displayClock = patch.clock;
  if (patch.locale) set.displayLocale = normalizeLocale(patch.locale);
  if (!Object.keys(set).length) return;
  await ctx.db
    .update(users)
    .set(set as Partial<DisplayCols>)
    .where(eq(users.id, userId));
}
