/**
 * Keep SparkyFitness's Health Connect sleep exactly what the phone just read.
 *
 * Why: SparkyFitness only replaces stored stages that fall inside an incoming upload's window (and
 * exact matches), so a night that was rescored in Health Connect (or had a nap removed) ended up
 * with a mix of the old and new stages, and a night deleted in Health Connect stayed forever. Its
 * PUT /api/sleep/:id deletes every stored stage of the entry and inserts the given ones, so after
 * forwarding a SleepSession we PUT the same stages onto the entry that already holds that night.
 * Deleting a night is a separate, deliberate step (`removeMissingSleep`): only the phone knows it
 * read every night of a date range, so it says so, and only then are entries in that range that
 * the phone did not send removed. Only entries whose source is 'Health Connect' are ever touched.
 *
 * Shared by the Gauntlet API and the phone's direct mode (no Gauntlet server).
 */
import type { SleepRow, SleepStageRow, SparkyClient } from './client.js';

export const HC_SLEEP_SOURCE = 'Health Connect';

/** The fields of a SleepSession record that a rewrite needs. */
export interface SleepRecordIn {
  entry_date: string;
  bedtime: string;
  wake_time: string;
  duration_in_seconds: number;
  stage_events: SleepStageRow[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The SleepSession records of a batch that carry what a rewrite needs (anything else is skipped). */
export function sleepRecordsOf(records: Record<string, unknown>[]): SleepRecordIn[] {
  const out: SleepRecordIn[] = [];
  for (const r of records) {
    if (r.type !== 'SleepSession') continue;
    const date = typeof r.entry_date === 'string' ? r.entry_date.slice(0, 10) : '';
    if (!DATE.test(date) || typeof r.bedtime !== 'string' || typeof r.wake_time !== 'string')
      continue;
    if (!Array.isArray(r.stage_events)) continue;
    out.push({
      entry_date: date,
      bedtime: r.bedtime,
      wake_time: r.wake_time,
      duration_in_seconds: Number(r.duration_in_seconds) || 0,
      stage_events: r.stage_events as SleepStageRow[],
    });
  }
  return out;
}

const kind = (s: SleepStageRow) => (s.stage_type ?? '').toLowerCase();
const stageKey = (s: SleepStageRow) =>
  `${kind(s)}|${Date.parse(s.start_time ?? '')}|${Date.parse(s.end_time ?? '')}`;

/** Do two stage lists hold the same stages (type and times, in any order)? */
export function sameStages(a: SleepStageRow[] | null | undefined, b: SleepStageRow[]): boolean {
  const have = a ?? [];
  if (have.length !== b.length) return false;
  const keys = new Set(have.map(stageKey));
  return keys.size === new Set(b.map(stageKey)).size && b.every((s) => keys.has(stageKey(s)));
}

const dateOf = (r: SleepRow) => String(r.entry_date ?? '').slice(0, 10);
const isHc = (r: SleepRow) => r.source === HC_SLEEP_SOURCE;

/**
 * After SleepSession records went to SparkyFitness: make each night's stored entry hold exactly the
 * stages that were sent. Returns how many entries were rewritten. A night that isn't stored (yet)
 * or already matches is left alone. One failed rewrite doesn't stop the others.
 */
export async function replaceSleep(
  client: SparkyClient,
  token: string,
  nights: SleepRecordIn[],
): Promise<number> {
  if (!nights.length) return 0;
  // The last record for a date wins (the phone sends one per night).
  const byDate = new Map(nights.map((n) => [n.entry_date, n]));
  const dates = [...byDate.keys()].sort();
  const stored = (await client.sleep(token, dates[0]!, dates.at(-1)!)).filter(isHc);
  let rewritten = 0;
  for (const row of stored) {
    const night = byDate.get(dateOf(row));
    if (!night || !row.id || sameStages(row.stage_events, night.stage_events)) continue;
    try {
      await client.updateSleep(token, row.id, {
        bedtime: night.bedtime,
        wake_time: night.wake_time,
        duration_in_seconds: night.duration_in_seconds,
        stage_events: night.stage_events,
      });
      rewritten++;
    } catch {
      /* the next sync tries again */
    }
  }
  return rewritten;
}

export interface SleepDaysIn {
  from: string;
  to: string;
  /** Every night (local day it ended on) the phone sent for this range. */
  dates: string[];
}

/**
 * The phone read every night of `from`..`to` and sent `dates`: remove the Health Connect entries in
 * that range for any other date (the night was deleted in Health Connect). Returns how many.
 */
export async function removeMissingSleep(
  client: SparkyClient,
  token: string,
  days: SleepDaysIn,
): Promise<number> {
  const sent = new Set(days.dates);
  const stored = (await client.sleep(token, days.from, days.to)).filter(isHc);
  let removed = 0;
  for (const row of stored) {
    const date = dateOf(row);
    if (!row.id || date < days.from || date > days.to || sent.has(date)) continue;
    try {
      await client.deleteSleep(token, row.id);
      removed++;
    } catch {
      /* the next sync tries again */
    }
  }
  return removed;
}
