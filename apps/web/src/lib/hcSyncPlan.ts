/**
 * How much of Health Connect one sync re-reads (pure, so it can be unit tested). Reading is the
 * expensive part: every sample crosses the Capacitor bridge as JSON and is parsed on the WebView's
 * main thread, so re-reading a week of per-minute heart rate on every app resume made the app stutter.
 *
 * The rule:
 * - A resume sync runs at most every RESUME_MIN_GAP_MS (the Sync now button always runs).
 * - FIRST (never synced, or the 30-day button): the whole range, everything sent, every origin read.
 * - FULL (last full one is over FULL_EVERY_MS old, so at least four a day when the app is in use):
 *   the last RESEND_DAYS days. This is what picks up late data (a watch syncing a day later) and a
 *   night's sleep that was edited or rescored: they land within 6 hours.
 * - LIGHT (every other sync): yesterday and today only. Sleep is safe because the night window is read
 *   from a day earlier and the sleep-days note only names the days actually read.
 * - Records and origins whose content is unchanged since they were last sent are skipped (hcSent.ts),
 *   except once every SEND_ALL_EVERY_MS (a full sync then sends everything, as a safety net, e.g. after
 *   the server was reset).
 * - The raw samples read only to learn who wrote a stat (steps, heart rate, ...) are the biggest read,
 *   so a full sync re-reads them for the older days only every ORIGINS_FULL_EVERY_MS, unless the person
 *   chose an app for that stat (then its value is made from them and they are always read in full).
 */
import { FIRST_SYNC_DAYS, RESEND_DAYS } from './healthRecords';

export const RESUME_MIN_GAP_MS = 8 * 60_000;
export const FULL_EVERY_MS = 6 * 3_600_000;
export const ORIGINS_FULL_EVERY_MS = 24 * 3_600_000;
export const SEND_ALL_EVERY_MS = 24 * 3_600_000;
/** Whole days before today a light sync starts from (yesterday + today). */
export const LIGHT_DAYS = 1;

/** When each kind of work last finished (ms since epoch; missing = never). */
export interface PlanState {
  lastFull?: number | null;
  lastOriginsFull?: number | null;
  lastSendAll?: number | null;
}

export interface SyncPlan {
  kind: 'first' | 'full' | 'light';
  /** Whole days before today the read starts from. */
  days: number;
  /** Skip no record: send everything read, whatever was sent before. */
  sendAll: boolean;
  /** Read the origin-only samples for the whole range (else only yesterday and today). */
  originsFull: boolean;
}

const older = (now: number, at: number | null | undefined, ms: number) =>
  at == null || !Number.isFinite(at) || now - at >= ms || at > now;

/** Should a resume (not the Sync now button) sync now? `lastSync` is when the last one finished. */
export function resumeDue(now: number, lastSync: number | null | undefined): boolean {
  return older(now, lastSync, RESUME_MIN_GAP_MS);
}

export function planSync(input: { now: number; state: PlanState; days?: number }): SyncPlan {
  const { now, state } = input;
  // An explicit range (the "last 30 days" button) or no full sync yet: read and send it all.
  if (input.days != null || state.lastFull == null)
    return {
      kind: 'first',
      days: input.days ?? FIRST_SYNC_DAYS,
      sendAll: true,
      originsFull: true,
    };
  if (older(now, state.lastFull, FULL_EVERY_MS))
    return {
      kind: 'full',
      days: RESEND_DAYS,
      sendAll: older(now, state.lastSendAll, SEND_ALL_EVERY_MS),
      originsFull: older(now, state.lastOriginsFull, ORIGINS_FULL_EVERY_MS),
    };
  return { kind: 'light', days: LIGHT_DAYS, sendAll: false, originsFull: false };
}

/** What to remember once a sync of this plan finished at `now`. */
export function nextState(prev: PlanState, plan: SyncPlan, now: number): PlanState {
  if (plan.kind === 'light') return prev;
  return {
    lastFull: now,
    lastOriginsFull: plan.originsFull ? now : prev.lastOriginsFull,
    lastSendAll: plan.sendAll ? now : prev.lastSendAll,
  };
}
