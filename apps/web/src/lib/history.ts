/**
 * History import from the app's side. With a Gauntlet server the heavy lifting is a server job (we
 * start it, poll it, cancel it). What only the phone can do runs here, in a small store that lives
 * outside any screen so it keeps going if you navigate away: reading Health Connect's older data,
 * and, without a server (direct mode), asking connected apps for older ranges through SparkyFitness.
 */
import {
  addDays,
  HISTORY_SUPPORT,
  planChunks,
  todayIn,
  windowDays,
  type ConnectionInfo,
  type HistoryStatus,
  type HistoryStep,
  type ProviderId,
} from '@gauntlet/shared';
import { useSyncExternalStore } from 'react';
import { del, get, post } from './api';
import { importHealthConnectHistory } from './health';
import type { HistoryAccess } from './historyPlan';
import { timezone } from './platform';
import { session } from './session';

export const historyApi = {
  status: () => get<HistoryStatus>('/api/me/history-import'),
  start: (days: number) => post<HistoryStatus>('/api/me/history-import', { days }),
  cancel: () => del<HistoryStatus>('/api/me/history-import'),
};

export interface PhoneStep extends HistoryStep {
  source: 'health_connect' | ProviderId;
}

export interface PhoneState {
  running: boolean;
  steps: PhoneStep[];
  /** A line to show when it ended (Health Connect found nothing older, and why). */
  message: string | null;
  cancelled: boolean;
}

let state: PhoneState = { running: false, steps: [], message: null, cancelled: false };
let abort: AbortController | null = null;
const listeners = new Set<() => void>();
const set = (next: Partial<PhoneState>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};
const patchStep = (source: string, patch: Partial<PhoneStep>) =>
  set({ steps: state.steps.map((s) => (s.source === source ? { ...s, ...patch } : s)) });

export const usePhoneImport = (): PhoneState =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );

export const cancelPhoneImport = () => abort?.abort();

const HC_NOTE =
  'Runs on this phone, so keep the app open until it finishes. It carries on where it stopped if you close it.';

/** Apps that can hand over older data (direct mode lists these itself; a server does it for us). */
export const importableApps = (list: ConnectionInfo[] | undefined) =>
  (list ?? []).filter(
    (c) =>
      c.state === 'connected' &&
      (HISTORY_SUPPORT[c.id].mode === 'range' || HISTORY_SUPPORT[c.id].mode === 'full'),
  );

/**
 * Run the phone's part of an import. Resolves true if it ran to the end (or as far as it could),
 * false if the person cancelled.
 */
export async function runPhoneImport(opts: {
  days: number;
  healthConnect: boolean;
  /** Direct mode only: connected apps to ask through SparkyFitness. */
  apps: ConnectionInfo[];
}): Promise<boolean> {
  const total = opts.days + 1;
  const base = (source: PhoneStep['source'], label: string, note: string | null): PhoneStep => ({
    source,
    label,
    state: 'waiting',
    doneDays: 0,
    totalDays: total,
    error: null,
    note,
  });
  abort = new AbortController();
  const { signal } = abort;
  set({
    running: true,
    cancelled: false,
    message: null,
    steps: [
      ...(opts.healthConnect
        ? [base('health_connect', 'Health Connect on this phone', HC_NOTE)]
        : []),
      ...opts.apps.map((a) => base(a.id, a.label, HISTORY_SUPPORT[a.id].note)),
    ],
  });
  try {
    if (opts.healthConnect) {
      patchStep('health_connect', { state: 'running' });
      try {
        const r = await importHealthConnectHistory(
          opts.days,
          (p) => patchStep('health_connect', { doneDays: p.doneDays, totalDays: p.totalDays }),
          signal,
        );
        patchStep('health_connect', {
          state: r.reason === 'cancelled' ? 'cancelled' : 'done',
          ...(r.reason === 'done' ? { doneDays: total } : {}),
          error: healthConnectNote(r.reason, r.access, r.oldestWithData, r.records),
        });
      } catch (err) {
        patchStep('health_connect', { state: 'failed', error: (err as Error).message });
      }
    }
    for (const app of opts.apps) {
      if (signal.aborted) break;
      await pullApp(app.id, opts.days, signal);
    }
  } finally {
    set({ running: false, cancelled: signal.aborted });
    abort = null;
  }
  return !signal.aborted;
}

/** What to tell the person about how far Health Connect went. */
export function healthConnectNote(
  reason: 'done' | 'cancelled' | 'ran_dry',
  access: HistoryAccess,
  oldest: string | null,
  records: number,
): string | null {
  if (reason === 'cancelled') return null;
  if (!records) {
    return access === 'granted'
      ? 'Health Connect has nothing in that time.'
      : 'Health Connect gave nothing older than 30 days. Allow “past data” for Gauntlet in Health Connect settings, then try again.';
  }
  if (reason === 'ran_dry') {
    const since = oldest ? ` Found data back to ${oldest}.` : '';
    return access === 'granted'
      ? `Nothing older turned up.${since}`
      : `Health Connect stopped at about 30 days, which is its limit until you allow “past data”.${since}`;
  }
  return null;
}

/** Direct mode: ask one app for the range, newest chunk first. */
async function pullApp(id: ProviderId, days: number, signal: AbortSignal) {
  const direct = session.direct;
  if (!direct) return;
  const support = HISTORY_SUPPORT[id];
  const end = todayIn('UTC');
  const start = addDays(todayIn(timezone), -days);
  patchStep(id, { state: 'running' });
  let failed = 0;
  let inARow = 0;
  let last = '';
  const windows =
    support.mode === 'full' ? [{ start, end }] : planChunks(start, end, support.chunkDays);
  for (const w of windows) {
    if (signal.aborted) {
      patchStep(id, { state: 'cancelled' });
      return;
    }
    try {
      await direct.pullAppRange(id, w.start, w.end, { full: support.mode === 'full' });
      inARow = 0;
    } catch (err) {
      failed++;
      last = (err as Error).message;
      const limited = /limiting|rate|too many/i.test(last);
      if (limited || ++inARow >= 3) {
        patchStep(id, { state: 'failed', error: `${last} Imported back to ${w.end}.` });
        return;
      }
    }
    patchStep(id, {
      doneDays: Math.min(
        days + 1,
        (state.steps.find((s) => s.source === id)?.doneDays ?? 0) + windowDays(w),
      ),
    });
    // Be gentle: Garmin and Fitbit rate-limit hard.
    await new Promise((r) => setTimeout(r, 1500));
  }
  patchStep(id, {
    state: 'done',
    doneDays: days + 1,
    error: failed
      ? `${failed} ${failed === 1 ? 'stretch' : 'stretches'} couldn't be imported (${last})`
      : null,
  });
}

/** Test hook: put the store back to idle. */
export function resetPhoneImport() {
  abort = null;
  set({ running: false, steps: [], message: null, cancelled: false });
}
