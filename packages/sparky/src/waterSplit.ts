/**
 * Water per source.
 *
 * SparkyFitness keeps every drink with its source ('manual' for what is logged in its own app,
 * 'Health Connect' for what the phone forwards), but its range endpoint adds all sources into one
 * number a day. A person who logs 80 oz in SparkyFitness while another app writes the same 80 oz to
 * Health Connect therefore looked like 160 oz. The one-day endpoint does break the total down
 * (manual vs everything synced), so Gauntlet asks it for each day with water and keeps one number
 * per source; the usual "one source counts" rule then picks between them like it does for steps.
 */
import type { WaterDayRow, WaterRow } from './client.js';

/** The source label SparkyFitness gives drinks logged in its own app. */
export const WATER_MANUAL = 'manual';
/** What the phone's sync writes, and so what any non-manual water is called here. */
export const WATER_SYNCED = 'Health Connect';
/** A day whose split isn't known (yet): its whole total, as a source of its own. */
export const WATER_UNSPLIT = 'water';

const ml = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * One day's rows, one per source. Water from food (an opt-in) counts with what was typed into
 * SparkyFitness, since that is where it comes from.
 */
export function waterRowsOfDay(date: string, day: WaterDayRow): WaterRow[] {
  const manual = ml(day.manual_ml) + ml(day.food_ml);
  const synced = Math.max(0, ml(day.ledger_ml) - ml(day.manual_ml));
  const out: WaterRow[] = [];
  if (manual > 0) out.push({ entry_date: date, water_ml: manual, source: WATER_MANUAL });
  if (synced > 0) out.push({ entry_date: date, water_ml: synced, source: WATER_SYNCED });
  return out;
}

/** The rows of a day with no known split. */
export const unsplitWaterRow = (date: string, total: number): WaterRow => ({
  entry_date: date,
  water_ml: total,
  source: WATER_UNSPLIT,
});

/** Does a split add up to the day's range total (so it is still the day's truth)? */
export function splitMatches(rows: WaterRow[], total: number): boolean {
  const sum = rows.reduce((a, r) => a + ml(r.water_ml), 0);
  return rows.length > 0 && Math.abs(sum - total) <= Math.max(5, total * 0.005);
}
