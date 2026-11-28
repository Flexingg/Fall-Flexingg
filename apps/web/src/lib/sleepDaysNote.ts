/**
 * When may the phone tell the server "these are all the nights I have for this range"? The server
 * deletes Health Connect nights it was not told about (a night deleted in Health Connect), so the
 * note is only made when the sleep read demonstrably saw everything: the read worked, it didn't
 * stop at the plugin's cap (the oldest nights would be missing), and an empty answer comes with
 * sleep access (without it Health Connect can answer "nothing" for a night that exists).
 */
import type { SleepDaysBody } from '@gauntlet/shared';

export function sleepDaysNote(input: {
  /** The sessions Health Connect returned, or null when the read failed. */
  read: unknown[] | null;
  cap: number;
  /** Whether sleep access is granted: null when it can't be told. */
  sleepAllowed: boolean | null;
  range: { from: string; to: string };
  /** The records about to be sent: their SleepSession nights are the ones kept. */
  records: Record<string, unknown>[];
}): SleepDaysBody | null {
  const { read, cap, sleepAllowed, range, records } = input;
  if (!read || read.length >= cap) return null;
  if (!read.length && sleepAllowed !== true) return null;
  const dates = new Set<string>();
  for (const r of records) {
    if (r.type !== 'SleepSession' || typeof r.entry_date !== 'string') continue;
    if (r.entry_date >= range.from && r.entry_date <= range.to) dates.add(r.entry_date);
  }
  return { from: range.from, to: range.to, dates: [...dates].sort() };
}
