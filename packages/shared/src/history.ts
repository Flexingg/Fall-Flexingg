/**
 * History import: pull up to five years of older data into Gauntlet. The contract between the
 * server job and the app, what each linked app can actually provide (so the screen can say so
 * instead of pretending), and the pure date-chunking helpers both sides share.
 */
import { z } from 'zod';
import { addDays, daysBetween } from './dates.js';
import { PROVIDER_IDS, type ProviderId } from './api.js';

/** Five years, with a leap day. */
export const HISTORY_MAX_DAYS = 1826;

/** The choices on the screen. */
export const HISTORY_RANGES = [
  { key: '3m', label: '3 months', days: 90 },
  { key: '1y', label: '1 year', days: 365 },
  { key: '2y', label: '2 years', days: 730 },
  { key: '5y', label: '5 years', days: HISTORY_MAX_DAYS },
] as const;

/** Steps are one per linked app, plus Gauntlet reading everything SparkyFitness has ('sparky'). */
export type HistorySourceId = ProviderId | 'sparky' | 'health_connect';

export const isHistorySource = (v: string): v is HistorySourceId =>
  v === 'sparky' || v === 'health_connect' || (PROVIDER_IDS as readonly string[]).includes(v);

export const startHistorySchema = z
  .object({
    /** Whole or half years back (up to 5). */
    years: z.number().min(0.25).max(5).optional(),
    days: z.number().int().min(1).max(HISTORY_MAX_DAYS).optional(),
    /** Limit the import to some sources; leave out for everything that is connected. */
    sources: z.array(z.string().refine(isHistorySource)).max(20).optional(),
  })
  .refine((b) => (b.years == null) !== (b.days == null), {
    message: 'Give either years or days',
  });
export type StartHistoryRequest = z.infer<typeof startHistorySchema>;

/** Days to import for a request, never more than five years. */
export function requestedDays(req: Pick<StartHistoryRequest, 'years' | 'days'>): number {
  const d = req.days ?? Math.round((req.years ?? 1) * 365.25);
  return Math.min(HISTORY_MAX_DAYS, Math.max(1, d));
}

/** How a linked app can be asked for older data. */
export interface HistorySupport {
  /**
   * `range`: SparkyFitness pulls any date range from the app. `full`: the app has no date filter,
   * so one call pulls everything. `recent`: the app only hands over its latest weeks.
   * `none`: nothing to pull.
   */
  mode: 'range' | 'full' | 'recent' | 'none';
  /** Days per request to SparkyFitness (SparkyFitness caps Garmin at 365; smaller is gentler). */
  chunkDays: number;
  /** Plain-English limit to show people. */
  note: string | null;
}

/** From SparkyFitness 1.7's sync routes: which accept startDate/endDate and what they do with them. */
export const HISTORY_SUPPORT: Record<ProviderId, HistorySupport> = {
  garmin: {
    mode: 'range',
    chunkDays: 30,
    note: 'Garmin limits how fast it hands data over, so years of history can take a while.',
  },
  strava: { mode: 'range', chunkDays: 90, note: null },
  fitbit: {
    mode: 'range',
    chunkDays: 14,
    note: 'Fitbit allows only a limited number of requests per hour, so this one is slow.',
  },
  oura: { mode: 'range', chunkDays: 90, note: null },
  polar: {
    mode: 'recent',
    chunkDays: 0,
    note: 'Polar only provides the last 4 weeks. Older data can’t be imported.',
  },
  coros: {
    mode: 'range',
    chunkDays: 30,
    note: 'COROS limits how many workout files it gives out per day, so very long imports may need a second run.',
  },
  hevy: {
    mode: 'full',
    chunkDays: 0,
    note: 'Hevy hands over your whole workout history in one go.',
  },
  liftosaur: { mode: 'range', chunkDays: 90, note: null },
  wger: {
    mode: 'none',
    chunkDays: 0,
    note: 'wger is an exercise library and has no activity to import.',
  },
};

export type HistoryStepState = 'waiting' | 'running' | 'done' | 'skipped' | 'failed' | 'cancelled';

export interface HistoryStep {
  source: HistorySourceId;
  label: string;
  state: HistoryStepState;
  doneDays: number;
  totalDays: number;
  /** Something a person can read: why it failed, or what was skipped. */
  error: string | null;
  /** A standing limit of this source, such as "Polar only provides the last 4 weeks". */
  note: string | null;
}

export interface HistorySummary {
  /** Oldest day with data before and after the import. */
  oldestBefore: string | null;
  oldestAfter: string | null;
  /** Days that had no data before and have some now. */
  newDays: number;
  newRecords: number;
  newBadges: number;
  workouts: number;
}

export type HistoryJobState = 'running' | 'done' | 'cancelled' | 'failed' | 'interrupted';

export interface HistoryStatus {
  /** True while the server is working on it. */
  running: boolean;
  /** `idle` when there has never been an import. */
  state: HistoryJobState | 'idle';
  range: { start: string; end: string; days: number } | null;
  steps: HistoryStep[];
  startedAt: string | null;
  finishedAt: string | null;
  summary: HistorySummary | null;
  /** Why the whole job stopped early, in words. */
  error: string | null;
}

export const IDLE_HISTORY: HistoryStatus = {
  running: false,
  state: 'idle',
  range: null,
  steps: [],
  startedAt: null,
  finishedAt: null,
  summary: null,
  error: null,
};

/** A window of days, both ends included. */
export interface DateWindow {
  start: string;
  end: string;
}

/**
 * Cut [start, end] into windows of at most `size` days, newest first, so the most recent (and most
 * useful) data lands before the oldest. Windows are consecutive and never overlap.
 */
export function planChunks(start: string, end: string, size: number): DateWindow[] {
  const out: DateWindow[] = [];
  if (end < start || size < 1) return out;
  let hi = end;
  while (hi >= start) {
    const lo = addDays(hi, -(size - 1));
    out.push({ start: lo < start ? start : lo, end: hi });
    hi = addDays(lo, -1);
  }
  return out;
}

/** Days covered by a window. */
export const windowDays = (w: DateWindow) => daysBetween(w.start, w.end) + 1;

/** "4 years 2 months", "5 months", "3 weeks" or "9 days": how far apart two dates are, for people. */
export function describeSpan(from: string, to: string): string {
  const days = Math.max(0, daysBetween(from, to));
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  let months = (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
  if (months < 1) {
    if (days >= 14) return `${Math.floor(days / 7)} weeks`;
    return `${days} ${days === 1 ? 'day' : 'days'}`;
  }
  const y = Math.floor(months / 12);
  months %= 12;
  const parts = [];
  if (y) parts.push(`${y} ${y === 1 ? 'year' : 'years'}`);
  if (months) parts.push(`${months} ${months === 1 ? 'month' : 'months'}`);
  return parts.join(' ');
}

/** Where Health Connect imports resume: the oldest day already sent, kept on the phone. */
export interface HealthConnectProgress {
  /** Oldest day sent so far in the import that is still going. */
  oldestDone: string;
  /** How far back that import was asked to go. */
  target: string;
}
