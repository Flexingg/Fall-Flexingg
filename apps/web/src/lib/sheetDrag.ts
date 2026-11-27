/**
 * The decisions behind swipe-to-close on bottom sheets, kept pure so they can be tested without a
 * browser: when a touch becomes a drag (and when it is really a scroll or a sideways swipe), how
 * far the sheet follows, and whether letting go closes it or springs it back.
 */

/** Finger travel before we decide what the gesture is. Small, so we claim it before the browser scrolls. */
export const SLOP = 6;
/** Closes when dragged past this share of the sheet's height... */
export const CLOSE_FRACTION = 0.25;
/** ...or released faster than this (px per ms) after dragging at least MIN_FLICK px. */
export const FLICK_VELOCITY = 0.5;
export const MIN_FLICK = 24;

export type DragIntent = 'pending' | 'drag' | 'ignore';

/**
 * What a gesture is after moving (dx, dy) from where it started.
 * - From the handle, any downward movement drags the sheet.
 * - From the body, only a mostly vertical, downward move while the sheet is scrolled to the top does;
 *   anything else is left to the browser so tall sheets still scroll.
 */
export function dragIntent(o: {
  dx: number;
  dy: number;
  fromHandle: boolean;
  scrollTop: number;
}): DragIntent {
  const { dx, dy, fromHandle, scrollTop } = o;
  if (fromHandle) return dy >= SLOP ? 'drag' : 'pending';
  if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return 'pending';
  if (Math.abs(dx) > Math.abs(dy)) return 'ignore';
  if (dy <= 0 || scrollTop > 0) return 'ignore';
  return 'drag';
}

/** The sheet only ever follows the finger down. */
export const followY = (dy: number): number => Math.max(0, dy);

/** Whether releasing now closes the sheet. */
export function shouldClose(o: { dy: number; height: number; velocity: number }): boolean {
  const { dy, height, velocity } = o;
  if (dy <= 0 || height <= 0) return false;
  return dy >= height * CLOSE_FRACTION || (velocity >= FLICK_VELOCITY && dy >= MIN_FLICK);
}

/** How much of the dimmed backdrop is left (1 = full, 0 = gone) when the sheet is dragged dy down. */
export function dimAmount(dy: number, height: number): number {
  if (height <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - dy / height));
}

/** Smooths the speed of the last move into a running estimate (px per ms, downward positive). */
export function nextVelocity(prev: number, dy: number, dt: number): number {
  if (dt <= 0) return prev;
  return prev * 0.4 + (dy / dt) * 0.6;
}
