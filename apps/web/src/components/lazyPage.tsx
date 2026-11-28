/**
 * Screens that are not a tab or the launch path load on demand, so the first screen starts sooner
 * on a phone. They are fetched quietly once the app is idle (RoutePrefetch), so opening one rarely
 * waits. A file that fails to load (an update replaced it) reloads the app once; see chunkReload.ts.
 */
import { Component, lazy, useEffect, type ComponentType, type ReactNode } from 'react';
import { reloadForStaleChunk } from '../lib/chunkReload';

type Loader = () => Promise<{ default: ComponentType }>;
const loaders: { load: Loader; admin: boolean }[] = [];

/** Like React.lazy, but remembered for prefetching, and a failed load reloads the app once. */
/** `admin` screens are only prefetched for server admins. */
export function lazyPage(load: Loader, opts: { admin?: boolean } = {}) {
  const guarded: Loader = () =>
    load().catch((err: unknown) => {
      // Never resolves when a reload started: the page is about to be replaced. (Offline, a reload
      // would not help, so the error shows instead.)
      if (navigator.onLine !== false && reloadForStaleChunk())
        return new Promise<never>(() => undefined);
      throw err;
    });
  loaders.push({ load, admin: !!opts.admin }); // prefetching must never reload the app
  return lazy(guarded);
}

/** Once the app is idle, fetch every on-demand screen one at a time (they stay in the HTTP cache). */
export function RoutePrefetch({ enabled, admin }: { enabled: boolean; admin: boolean }) {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let i = 0;
    const idle = (fn: () => void) =>
      'requestIdleCallback' in window
        ? void window.requestIdleCallback(fn, { timeout: 4000 })
        : void (timer = setTimeout(fn, 1500));
    const next = () => {
      if (cancelled || i >= loaders.length) return;
      const { load, admin: adminOnly } = loaders[i++]!;
      if (adminOnly && !admin) return next();
      load()
        .catch(() => undefined)
        .finally(() => idle(next));
    };
    // Let the first screen settle before spending the phone's time on the rest.
    timer = setTimeout(() => idle(next), 2500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, admin]);
  return null;
}

/** A screen that still failed to load after the one reload: say so instead of a blank page. */
export class LoadFailed extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="screen no-tabs" style={{ textAlign: 'center', paddingTop: 80 }}>
        <p>Couldn’t load this screen. Check your connection and try again.</p>
        <button className="btn" onClick={() => window.location.reload()}>
          Reload
        </button>
      </main>
    );
  }
}
