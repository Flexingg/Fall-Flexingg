/**
 * Leaderboard movement. When fresh numbers change the order, rows slide to their new place (FLIP:
 * note where each row was, let React move it, then animate from the old spot) and the scores count
 * up. A row that moved up flashes lime. Nothing moves on first render or with reduced motion.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { success } from '../lib/haptics';
import { interpolate, prefersReducedMotion } from '../lib/motion';

export const SLIDE_MS = 350;
export const COUNT_MS = 600;
const FLASH_MS = 1200;

/**
 * Put the returned ref on the list; give each row `data-flip="<stable id>"`. `order` should change
 * whenever the rows' order may have (it is only used to know when to look).
 */
export function useFlip(order: string): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  const tops = useRef<Map<string, number> | null>(null);
  useLayoutEffect(() => {
    const list = ref.current;
    if (!list) return;
    const rows = [...list.querySelectorAll<HTMLElement>('[data-flip]')];
    const before = tops.current;
    const now = new Map<string, number>();
    // offsetTop ignores transforms in flight and doesn't change when the page scrolls.
    for (const el of rows) now.set(el.dataset.flip!, el.offsetTop);
    tops.current = now;
    if (!before || prefersReducedMotion()) return;
    for (const el of rows) {
      const prev = before.get(el.dataset.flip!);
      const cur = now.get(el.dataset.flip!)!;
      if (prev == null || prev === cur) continue;
      el.style.transition = 'none';
      el.style.transform = `translateY(${prev - cur}px)`;
      void el.offsetHeight; // commit the starting position
      el.style.transition = `transform ${SLIDE_MS}ms ease`;
      el.style.transform = '';
      const clear = () => {
        el.style.transition = '';
      };
      el.addEventListener('transitionend', clear, { once: true });
      setTimeout(clear, SLIDE_MS + 100);
      if (cur < prev) {
        el.classList.add('rank-up');
        setTimeout(() => el.classList.remove('rank-up'), FLASH_MS);
      }
    }
  }, [order]);
  return ref;
}

/** Fire the success buzz when the viewer's own rank gets better (1 is best) while watching. */
export function useRankHaptics(myRank: number | null | undefined) {
  const last = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    const prev = last.current;
    last.current = myRank;
    if (prev != null && myRank != null && myRank < prev) success();
  }, [myRank]);
}

/** A number that counts up (or down) to its new value instead of jumping. */
export function CountUp({
  value,
  format,
}: {
  value: number | null;
  format: (v: number | null) => string;
}) {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);
  useEffect(() => {
    const from = shownRef.current;
    if (value === from) return;
    if (from == null || value == null || prefersReducedMotion()) {
      shownRef.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = (now - start) / COUNT_MS;
      shownRef.current = interpolate(from, value, t);
      setShown(shownRef.current);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{format(shown)}</>;
}
