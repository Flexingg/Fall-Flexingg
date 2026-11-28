/**
 * Swipe-to-close for bottom sheets. Attach sheetRef / overlayRef to the sheet and its backdrop and
 * render <SheetHandle drag={...}/> at the top. Dragging the handle always works; a touch drag on the
 * body works only when the sheet is scrolled to the top and moves down, so tall sheets still scroll.
 * The sheet follows the finger with no transition, the backdrop fades (via --sheet-dim), and letting
 * go either closes it (past a quarter of its height, or a quick flick) or springs it back. Styles are
 * set on the elements directly, not through React state, so a drag costs no renders.
 */
import { useEffect, useRef } from 'react';
import { useBackHandler } from './useBackHandler';
import {
  dimAmount,
  dragIntent,
  followY,
  nextVelocity,
  shouldClose,
  type DragIntent,
} from './sheetDrag';

const SETTLE_MS = 200;

interface Gesture {
  x0: number;
  y0: number;
  lastY: number;
  lastT: number;
  velocity: number;
  fromHandle: boolean;
  mode: DragIntent;
  height: number;
  dy: number;
}

const reducedMotion = () =>
  typeof window !== 'undefined' &&
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function useSheetDrag(onClose: () => void) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  // Android back (gesture or button) closes the sheet first, sinking it as the finger moves.
  useBackHandler(onClose, { kind: 'sheet', target: sheetRef, overlay: overlayRef });
  const g = useRef<Gesture | null>(null);
  /** True after a real drag, so the click that follows it on the handle doesn't also close. */
  const dragged = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  const ctl = useRef({
    start(x: number, y: number, fromHandle: boolean) {
      const sheet = sheetRef.current;
      if (!sheet) return;
      window.clearTimeout(timer.current);
      dragged.current = false;
      g.current = {
        x0: x,
        y0: y,
        lastY: y,
        lastT: performance.now(),
        velocity: 0,
        fromHandle,
        mode: 'pending',
        height: sheet.getBoundingClientRect().height,
        dy: 0,
      };
    },
    /** Returns true while the sheet is being dragged (the caller should stop the page scrolling). */
    move(x: number, y: number): boolean {
      const s = g.current;
      const sheet = sheetRef.current;
      if (!s || !sheet || s.mode === 'ignore') return false;
      if (s.mode === 'pending') {
        s.mode = dragIntent({
          dx: x - s.x0,
          dy: y - s.y0,
          fromHandle: s.fromHandle,
          scrollTop: sheet.scrollTop,
        });
        if (s.mode !== 'drag') return false;
        // Count from here so the sheet doesn't jump by the slop distance.
        s.y0 = y;
        s.lastY = y;
        s.lastT = performance.now();
        dragged.current = true;
        sheet.style.transition = 'none';
        sheet.style.animation = 'none';
        sheet.style.willChange = 'transform';
        return true;
      }
      const now = performance.now();
      s.velocity = nextVelocity(s.velocity, y - s.lastY, now - s.lastT);
      s.lastY = y;
      s.lastT = now;
      s.dy = followY(y - s.y0);
      sheet.style.transform = `translateY(${s.dy}px)`;
      overlayRef.current?.style.setProperty('--sheet-dim', String(dimAmount(s.dy, s.height)));
      return true;
    },
    end() {
      const s = g.current;
      const sheet = sheetRef.current;
      g.current = null;
      if (!s || !sheet || s.mode !== 'drag') return;
      const still = performance.now() - s.lastT > 100; // held still before letting go: not a flick
      const close = shouldClose({ dy: s.dy, height: s.height, velocity: still ? 0 : s.velocity });
      const ms = reducedMotion() ? 0 : SETTLE_MS;
      sheet.style.transition = ms ? `transform ${ms}ms ease-out` : 'none';
      sheet.style.transform = `translateY(${close ? s.height : 0}px)`;
      overlayRef.current?.style.setProperty('--sheet-dim', close ? '0' : '1');
      if (close) {
        // Leave the sheet off screen; the parent unmounts it.
        timer.current = window.setTimeout(() => closeRef.current(), ms);
      } else {
        timer.current = window.setTimeout(() => {
          sheet.style.transition = '';
          sheet.style.transform = '';
          sheet.style.willChange = '';
        }, ms);
      }
    },
  });

  // Touch drags on the body need a non-passive listener so we can stop the browser scrolling.
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const c = ctl.current;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t || e.touches.length > 1 || handleRef.current?.contains(e.target as Node)) return;
      c.start(t.clientX, t.clientY, false);
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (t && c.move(t.clientX, t.clientY) && e.cancelable) e.preventDefault();
    };
    const onEnd = () => c.end();
    sheet.addEventListener('touchstart', onStart, { passive: true });
    sheet.addEventListener('touchmove', onMove, { passive: false });
    sheet.addEventListener('touchend', onEnd);
    sheet.addEventListener('touchcancel', onEnd);
    return () => {
      sheet.removeEventListener('touchstart', onStart);
      sheet.removeEventListener('touchmove', onMove);
      sheet.removeEventListener('touchend', onEnd);
      sheet.removeEventListener('touchcancel', onEnd);
      window.clearTimeout(timer.current);
    };
  });

  const handleProps = {
    onPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      ctl.current.start(e.clientX, e.clientY, true);
    },
    onPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
      ctl.current.move(e.clientX, e.clientY);
    },
    onPointerUp() {
      ctl.current.end();
    },
    onPointerCancel() {
      ctl.current.end();
    },
    onClick() {
      if (dragged.current) {
        dragged.current = false;
        return;
      }
      closeRef.current();
    },
  };

  return { sheetRef, overlayRef, handleRef, handleProps };
}

export type SheetDrag = ReturnType<typeof useSheetDrag>;
