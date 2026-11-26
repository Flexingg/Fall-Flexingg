/** Shared bits for the rank animations: the reduced-motion check and the count-up curve. */

export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Fast at first, settling at the end. */
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

/** The number to show `t` (0 to 1) of the way from one score to another; exactly `to` at the end. */
export function interpolate(from: number, to: number, t: number): number {
  if (t >= 1) return to;
  return from + (to - from) * easeOutCubic(t);
}
