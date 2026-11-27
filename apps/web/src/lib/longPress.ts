/**
 * Long-press logic for "press and hold a stat to see where it came from", kept free of React so it
 * can be tested with fake timers. A press opens after HOLD_MS if the pointer has not wandered more
 * than TOLERANCE_PX; scrolling or lifting early cancels it. After it opens, the click that follows
 * the finger lifting is swallowed (`consumeClick`) so the row's normal tap does not also fire.
 */
export const HOLD_MS = 500;
export const TOLERANCE_PX = 10;

export const movedTooFar = (x0: number, y0: number, x: number, y: number, tol = TOLERANCE_PX) =>
  Math.hypot(x - x0, y - y0) > tol;

/** The keys that open a context menu from the keyboard: the Menu key, or Shift+F10. */
export const isMenuKey = (e: { key: string; shiftKey?: boolean }) =>
  e.key === 'ContextMenu' || (e.key === 'F10' && !!e.shiftKey);

export interface LongPressOptions {
  onOpen: () => void;
  holdMs?: number;
  tolerance?: number;
}

export function createLongPress(o: LongPressOptions) {
  const holdMs = o.holdMs ?? HOLD_MS;
  const tol = o.tolerance ?? TOLERANCE_PX;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let origin: { x: number; y: number } | null = null;
  let fired = false;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    origin = null;
  };
  const open = () => {
    fired = true;
    clear();
    o.onOpen();
  };

  return {
    down(x: number, y: number) {
      clear();
      fired = false;
      origin = { x, y };
      timer = setTimeout(open, holdMs);
    },
    move(x: number, y: number) {
      if (origin && movedTooFar(origin.x, origin.y, x, y, tol)) clear();
    },
    /** Finger lifted, pointer cancelled or the page scrolled: stop waiting. */
    cancel: clear,
    /** Right-click, the long-press menu on Android, or the keyboard: open now (once per press). */
    openNow() {
      if (!fired) open();
    },
    /** True once (and only after an open) for the click that ends a long press. */
    consumeClick() {
      const was = fired;
      fired = false;
      return was;
    },
    get pending() {
      return timer != null;
    },
  };
}
