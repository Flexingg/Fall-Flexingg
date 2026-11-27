/**
 * The small pure decisions behind history import on the phone (kept apart from the Health Connect
 * plugin so they can be unit tested): can Health Connect show past data, where does an interrupted
 * import carry on, and how a status reads in words.
 */
import {
  addDays,
  describeSpan,
  type HealthConnectProgress,
  type HistoryStatus,
  type HistoryStep,
  type HistorySummary,
} from '@gauntlet/shared';

/**
 * Whether Health Connect will give us data older than 30 days: `granted` (past data allowed),
 * `not_granted` (the person can still allow it), `unsupported` (this Health Connect is too old to
 * ever allow it) or `unknown` (the plugin could not say).
 */
export type HistoryAccess = 'granted' | 'not_granted' | 'unsupported' | 'unknown';

export function historyAccessOf(s: {
  historyAccessAuthorized?: boolean;
  historyAccessAvailable?: boolean;
}): HistoryAccess {
  if (s.historyAccessAvailable === false) return 'unsupported';
  if (s.historyAccessAuthorized === true) return 'granted';
  if (s.historyAccessAuthorized === false) return 'not_granted';
  return 'unknown';
}

/** The day an unfinished import carries on from (the day before the oldest done), if it can. */
export function resumePoint(
  saved: HealthConnectProgress | null,
  target: string,
  today: string,
): string | null {
  if (!saved || saved.oldestDone <= target || saved.oldestDone > today) return null;
  return addDays(saved.oldestDone, -1);
}

/** 0-100 for a progress bar. */
export function stepPercent(s: Pick<HistoryStep, 'doneDays' | 'totalDays' | 'state'>): number {
  if (s.state === 'done') return 100;
  if (s.totalDays <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((s.doneDays / s.totalDays) * 100)));
}

/** What a step is doing, in plain English. */
export function stepLabel(s: Pick<HistoryStep, 'state' | 'doneDays' | 'totalDays'>): string {
  switch (s.state) {
    case 'waiting':
      return 'Waiting';
    case 'running':
      return `${stepPercent(s)}%`;
    case 'done':
      return 'Done';
    case 'skipped':
      return 'Not possible';
    case 'failed':
      return 'Stopped';
    case 'cancelled':
      return 'Cancelled';
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Added 4 years 2 months of data · 3 new records · 6 badges", or why there is nothing to say. */
export function summaryLine(sum: HistorySummary, today: string): string {
  const parts: string[] = [];
  if (sum.oldestAfter && (!sum.oldestBefore || sum.oldestAfter < sum.oldestBefore) && sum.newDays)
    parts.push(`Added ${describeSpan(sum.oldestAfter, sum.oldestBefore ?? today)} of data`);
  else if (sum.newDays) parts.push(`Added ${plural(sum.newDays, 'day')} of data`);
  else parts.push('No older data turned up');
  if (sum.newRecords) parts.push(plural(sum.newRecords, 'new record'));
  if (sum.newBadges) parts.push(plural(sum.newBadges, 'badge'));
  return parts.join(' · ');
}

/** The headline for a finished (or stopped) import. */
export function headline(st: HistoryStatus): string | null {
  if (st.state === 'done') return 'Import finished';
  if (st.state === 'cancelled') return 'Import stopped. What was imported is kept.';
  if (st.state === 'failed') return 'Import stopped early';
  if (st.state === 'interrupted') return 'Import was interrupted';
  return null;
}
