/**
 * "Undo" instead of "Are you sure?". The screen changes straight away; the real request waits
 * UNDO_MS behind a toast with an Undo button. If the person leaves or hides the app first, the
 * waiting requests are sent right then so nothing is lost. The timers live here, not in a page,
 * so leaving the page (which the leave-challenge flow does at once) doesn't drop them.
 */
import { useSyncExternalStore } from 'react';
import { toast } from './toast';

export const UNDO_MS = 5000;

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  commit: () => Promise<unknown>;
  settle: (err?: unknown) => void;
}

const pending = new Map<string, Pending>();
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function changed() {
  snapshot = new Set(pending.keys());
  listeners.forEach((fn) => fn());
}

async function commitNow(key: string) {
  const p = pending.get(key);
  if (!p) return;
  clearTimeout(p.timer);
  // Stay "pending" (so screens keep it hidden) until the request is done.
  try {
    await p.commit();
    pending.delete(key);
    changed();
    p.settle();
  } catch (err) {
    pending.delete(key);
    changed();
    p.settle(err);
  }
}

/**
 * Do something after UNDO_MS unless undone. `key` identifies it (e.g. `unfriend:<id>`) so screens
 * can hide the thing meanwhile (see usePendingUndo). `settle` runs after it was sent (no error),
 * failed (the error) or was undone (no argument): refresh your queries there.
 */
export function deferAction(opts: {
  key: string;
  message: string;
  commit: () => Promise<unknown>;
  settle?: (err?: unknown) => void;
  ms?: number;
}): void {
  const { key, message, commit, ms = UNDO_MS } = opts;
  if (pending.has(key)) return;
  const settle = opts.settle ?? (() => undefined);
  const timer = setTimeout(() => void commitNow(key), ms);
  pending.set(key, { timer, commit, settle });
  changed();
  toast(message, {
    duration: ms,
    action: { label: 'Undo', onClick: () => undoAction(key) },
  });
}

export function undoAction(key: string): void {
  const p = pending.get(key);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(key);
  changed();
  p.settle();
}

/** Send everything that is waiting, now (the page is being left or hidden). */
export function flushPending(): Promise<void> {
  return Promise.all([...pending.keys()].map(commitNow)).then(() => undefined);
}

export const isPendingUndo = (key: string) => pending.has(key);

/** The keys waiting right now; re-renders when they change. */
export function usePendingUndo(): ReadonlySet<string> {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => snapshot,
    () => snapshot,
  );
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushPending();
  });
  window.addEventListener('pagehide', () => void flushPending());
}
