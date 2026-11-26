/**
 * The toast channel, kept apart from the React host (components/ui.tsx) so plain modules like the
 * undo queue can show toasts without pulling in screens.
 */
export interface ToastOptions {
  /** A button on the toast, e.g. Undo. */
  action?: { label: string; onClick: () => void };
  /** How long it stays, in ms (default 2.6 s). */
  duration?: number;
}
export interface ToastState extends ToastOptions {
  msg: string;
  /** Changes with every toast so the same text twice still restarts the timer. */
  id: number;
}

export const DEFAULT_TOAST_MS = 2600;

let setter: ((t: ToastState | null) => void) | null = null;
let seq = 0;

export function toast(msg: string, opts: ToastOptions = {}) {
  setter?.({ msg, id: ++seq, ...opts });
}

/** Used by ToastHost. */
export function attachToastHost(fn: ((t: ToastState | null) => void) | null) {
  setter = fn;
}
