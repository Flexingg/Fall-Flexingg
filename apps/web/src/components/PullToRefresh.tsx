import { useEffect, useRef, useState } from 'react';
import { useSyncNow } from '../lib/freshness';
import { Icon } from './Icon';

/** How far (px) to pull before letting go syncs. */
const TRIGGER = 72;
const MAX = 110;

/**
 * Pull down from the top of any screen to sync everything (touch screens; elsewhere the Sync
 * buttons do the same). Mounted once while signed in.
 */
export function PullToRefresh() {
  const { busy, sync } = useSyncNow();
  const [pull, setPull] = useState(0);
  const start = useRef<number | null>(null);
  const dist = useRef(0);

  useEffect(() => {
    const atTop = () => (document.scrollingElement?.scrollTop ?? window.scrollY) <= 0;
    const inScroller = (el: EventTarget | null) => {
      for (let n = el as HTMLElement | null; n && n !== document.body; n = n.parentElement) {
        if (n.scrollHeight > n.clientHeight + 2 && n.scrollTop > 0) return true;
        if (n.matches('input, textarea, select, [role="dialog"]')) return true;
      }
      return false;
    };
    const onStart = (e: TouchEvent) => {
      start.current =
        e.touches.length === 1 && atTop() && !inScroller(e.target) ? e.touches[0]!.clientY : null;
      dist.current = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (start.current == null) return;
      const dy = e.touches[0]!.clientY - start.current;
      if (dy <= 0 || !atTop()) {
        dist.current = 0;
        setPull(0);
        return;
      }
      // Resistance: the further you pull, the slower it follows.
      dist.current = Math.min(MAX, dy * 0.5);
      setPull(dist.current);
    };
    const onEnd = () => {
      if (start.current != null && dist.current >= TRIGGER) void sync();
      start.current = null;
      dist.current = 0;
      setPull(0);
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, [sync]);

  const shown = busy ? TRIGGER * 0.6 : pull;
  if (!shown) return null;
  const ready = pull >= TRIGGER;
  return (
    <div
      className={`ptr${ready || busy ? ' ready' : ''}`}
      style={{ transform: `translate(-50%, ${shown - 44}px)` }}
      role="status"
      aria-live="polite"
    >
      <span style={busy ? undefined : { transform: `rotate(${pull * 4}deg)` }}>
        <Icon name="refresh" size={18} className={busy ? 'spin' : undefined} />
      </span>
      <span className="sr-only">
        {busy ? 'Syncing' : ready ? 'Release to sync' : 'Pull to sync'}
      </span>
    </div>
  );
}
