/**
 * Handlers that make an element open something on a long press (about half a second), a right-click,
 * or the keyboard's Menu key / Shift+F10 (see lib/longPress.ts). Spread the result on the element.
 * Gives a light haptic on the phone when it opens. The press is cancelled by scrolling.
 */
import { useEffect, useMemo, useRef } from 'react';
import { tap } from './haptics';
import { createLongPress, isMenuKey } from './longPress';

export function useLongPress(onOpen: () => void) {
  const latest = useRef(onOpen);
  useEffect(() => {
    latest.current = onOpen;
  });
  const lp = useMemo(
    () =>
      createLongPress({
        onOpen: () => {
          tap();
          latest.current();
        },
      }),
    [],
  );
  useEffect(() => lp.cancel, [lp]);

  return useMemo(() => {
    const onScroll = () => lp.cancel();
    const stopWatching = () => window.removeEventListener('scroll', onScroll, true);
    return {
      onPointerDown(e: React.PointerEvent) {
        // Only the main button (or a finger); a right-click comes through onContextMenu.
        if (e.button !== 0) return;
        lp.down(e.clientX, e.clientY);
        window.addEventListener('scroll', onScroll, { capture: true, passive: true });
      },
      onPointerMove(e: React.PointerEvent) {
        lp.move(e.clientX, e.clientY);
      },
      onPointerUp() {
        lp.cancel();
        stopWatching();
      },
      onPointerCancel() {
        lp.cancel();
        stopWatching();
      },
      onContextMenu(e: React.MouseEvent) {
        e.preventDefault();
        lp.openNow();
      },
      onKeyDown(e: React.KeyboardEvent) {
        if (!isMenuKey(e)) return;
        e.preventDefault();
        lp.openNow();
        // Keyboard opens have no click to swallow.
        lp.consumeClick();
      },
      /** The tap that ends a long press must not also open the row's normal action. */
      onClickCapture(e: React.MouseEvent) {
        if (lp.consumeClick()) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
    };
  }, [lp]);
}
