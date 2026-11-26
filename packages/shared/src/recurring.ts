/**
 * Recurring challenges: when a round ends the next one starts the day after, same length.
 * Season tables (wins and podiums across a series' finished rounds) are shared types.
 */
import { addDays, daysBetween } from './dates.js';
import type { Recurrence } from './notify.js';
import type { PublicUser } from './api.js';

/**
 * Dates of the round after one that ran `startDate`..`endDate`: it starts the day after the last
 * one ends and runs the same number of days. "Every week" and "every month" only name how long
 * rounds usually are; to keep things simple (and predictable) the rule is the same for both, so a
 * 30-day challenge set to repeat monthly simply runs back to back.
 */
export function nextRoundDates(startDate: string, endDate: string): { start: string; end: string } {
  const start = addDays(endDate, 1);
  return { start, end: addDays(start, daysBetween(startDate, endDate)) };
}

export function recurrenceLabel(r: Recurrence): string {
  return r.every === 'week' ? 'Repeats weekly' : 'Repeats monthly';
}

export interface SeasonRow {
  user: PublicUser;
  /** Rounds finished in first place (ties count). */
  wins: number;
  /** Rounds finished in the top three, wins included. */
  podiums: number;
  rounds: number;
}

export interface SeriesRoundLink {
  id: string;
  round: number;
  startDate: string;
  endDate: string;
}

/** Where a challenge sits in a recurring series. */
export interface SeriesInfo {
  round: number;
  /** Earlier rounds the viewer can open. */
  previous: SeriesRoundLink[];
  /** The following round, once it exists. */
  next: SeriesRoundLink | null;
  /** Wins and podiums per person across the series' finished rounds. Empty until one finishes. */
  season: SeasonRow[];
}
