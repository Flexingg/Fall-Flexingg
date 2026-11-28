import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { createGesture, type Gesture } from '../lib/predictiveBackMotion';
import {
  backHandlerCount,
  backVersion,
  canGoBackInApp,
  edgeOf,
  subscribeBack,
  wantsBack,
} from '../lib/predictiveBack';
import { listenForBack, setNativeBackEnabled } from '../lib/predictiveBackNative';
import '../styles/predictiveBack.css';

/**
 * Android's back gesture and button for the whole app (lib/predictiveBack.ts). It keeps the native
 * back callback on only while there is something to do (a sheet open, or a page to go back to) so
 * the system's own back-to-home animation plays at the root, and turns the gesture the plugin
 * reports into the shrinking-page / sinking-sheet animation, then the back itself.
 */
export function PredictiveBack() {
  const navigate = useNavigate();
  const location = useLocation();
  const goBack = useRef(() => navigate(-1));
  useEffect(() => {
    goBack.current = () => navigate(-1);
  });
  const gesture = useRef<Gesture | null>(null);
  useEffect(() => {
    const g = createGesture(() => goBack.current());
    gesture.current = g;
    const off = listenForBack({
      started: (edge) => g.started(edgeOf(edge)),
      progress: (p, edge) => g.progress(p, edgeOf(edge)),
      cancelled: () => g.cancelled(),
      invoked: () => g.invoked(),
    });
    return () => {
      off();
      g.dispose();
      gesture.current = null;
    };
  }, []);

  // Before the new page is painted: fade it in if the person just swiped back to it.
  useLayoutEffect(() => {
    gesture.current?.routeCommitted();
  }, [location.key]);

  // Is there anything for back to do? Re-checked whenever sheets open/close or the route changes.
  useSyncExternalStore(subscribeBack, backVersion);
  const handlers = backHandlerCount();
  // location.key is read so this re-renders on navigation; history.state is already updated by then.
  const canGoBack = location.key !== undefined && canGoBackInApp();
  const on = wantsBack(handlers, canGoBack);
  useEffect(() => {
    setNativeBackEnabled(on);
  }, [on]);
  return null;
}
