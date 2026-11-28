/**
 * Android's predictive back, the web half. Two pure pieces live here:
 *  - a stack of "back handlers": every open sheet or dialog registers one, and the top one wins, so
 *    back closes the sheet before it leaves the page (lib/useBackHandler.ts);
 *  - the frame maths: how far a page, sheet or dialog shrinks, shifts and fades at a given gesture
 *    progress (0 to 1), like Android 14+'s own back animations.
 * The native half (PredictiveBackPlugin.java) only says "started / progress / cancelled / invoked";
 * lib/predictiveBackMotion.ts turns those into movement, components/PredictiveBack.tsx wires it up.
 */
import type { RefObject } from 'react';

export type BackKind = 'sheet' | 'dialog';

export interface BackHandler {
  kind: BackKind;
  /** Close the sheet or dialog (whatever tapping its backdrop does). */
  close: () => void;
  /** The panel that follows the finger (for a sheet, the part that slides). */
  target?: RefObject<HTMLElement | null>;
  /** The backdrop, which fades as the panel goes. */
  overlay?: RefObject<HTMLElement | null>;
}

const stack: BackHandler[] = [];
const listeners = new Set<() => void>();
let version = 0;

const changed = () => {
  version++;
  listeners.forEach((l) => l());
};

/** Put a handler on top of the stack; call the returned function to take it off again. */
export function registerBackHandler(h: BackHandler): () => void {
  stack.push(h);
  changed();
  return () => {
    const i = stack.lastIndexOf(h);
    if (i >= 0) stack.splice(i, 1);
    changed();
  };
}

/** The sheet or dialog that back should close first, if any. */
export const topBackHandler = (): BackHandler | undefined => stack[stack.length - 1];
export const backHandlerCount = (): number => stack.length;

/** For useSyncExternalStore: changes whenever a handler is added or removed. */
export function subscribeBack(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
export const backVersion = (): number => version;

/** React Router keeps the position in the app's own history in `history.state.idx`. */
export function canGoBackInApp(
  state: unknown = typeof window !== 'undefined' ? window.history.state : null,
): boolean {
  const idx = (state as { idx?: unknown } | null)?.idx;
  return typeof idx === 'number' && idx > 0;
}

/**
 * Should Android hand back to the app? Only when there is something to do: a sheet to close or a
 * page to go back to. Otherwise the callback stays off, so the system plays its own back-to-home
 * animation and moves the app to the background.
 */
export const wantsBack = (handlers: number, canGoBack: boolean): boolean =>
  handlers > 0 || canGoBack;

export const clamp01 = (n: number): number =>
  Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;

/** Which side the swipe started from (BackEventCompat.EDGE_LEFT is 0, EDGE_RIGHT is 1). */
export type SwipeEdge = 'left' | 'right';
export const edgeOf = (n: unknown): SwipeEdge => (n === 1 || n === 'right' ? 'right' : 'left');

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The page being left: shrinks to 90%, slides a little toward the finger's edge, rounds, and dims what is behind. */
export function pageFrame(progress: number, edge: SwipeEdge) {
  const p = clamp01(progress);
  return {
    scale: lerp(1, 0.9, p),
    // The page moves away from the edge the finger came in from, like Android's.
    shiftX: (edge === 'left' ? 1 : -1) * lerp(0, 14, p),
    radius: lerp(0, 28, Math.min(1, p * 4)),
    dim: lerp(0, 0.5, p),
  };
}

/** A bottom sheet: sinks and shrinks a little, and its backdrop fades (--sheet-dim, 1 to 0). */
export function sheetFrame(progress: number, height: number) {
  const p = clamp01(progress);
  return {
    scale: lerp(1, 0.94, p),
    translateY: lerp(0, Math.min(Math.max(height, 0) * 0.3, 160), p),
    dim: 1 - p,
  };
}

/** A centred dialog or full-screen card: shrinks and fades. */
export function dialogFrame(progress: number) {
  const p = clamp01(progress);
  return { scale: lerp(1, 0.9, p), opacity: lerp(1, 0.4, p) };
}

/** What a back event should act on right now. */
export type BackTarget = 'sheet' | 'dialog' | 'page' | 'none';
export function backTarget(top: BackHandler | undefined, canGoBack: boolean): BackTarget {
  if (top) return top.kind;
  return canGoBack ? 'page' : 'none';
}
