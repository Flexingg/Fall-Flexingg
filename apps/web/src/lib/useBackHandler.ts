/**
 * Let an open sheet or dialog take the back gesture / button (see lib/predictiveBack.ts). Call it in
 * the component that renders the sheet; while it is mounted (and `enabled`), back closes it first.
 * Returns refs to put on the panel that should follow the finger and on its backdrop; useSheetDrag
 * passes its own refs instead.
 */
import { useEffect, useRef, type RefObject } from 'react';
import { registerBackHandler, type BackKind } from './predictiveBack';

interface Options {
  kind?: BackKind;
  enabled?: boolean;
  target?: RefObject<HTMLElement | null>;
  overlay?: RefObject<HTMLElement | null>;
}

export function useBackHandler(close: () => void, opts: Options = {}) {
  const { kind = 'dialog', enabled = true } = opts;
  const ownTarget = useRef<HTMLDivElement>(null);
  const ownOverlay = useRef<HTMLDivElement>(null);
  const target = opts.target ?? ownTarget;
  const overlay = opts.overlay ?? ownOverlay;
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!enabled) return;
    return registerBackHandler({ kind, close: () => closeRef.current(), target, overlay });
  }, [enabled, kind, target, overlay]);
  return { targetRef: ownTarget, overlayRef: ownOverlay };
}
