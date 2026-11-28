/**
 * The Android side of predictive back (PredictiveBackPlugin.java). The plugin owns the system's back
 * callback; JS says whether it should be on (only when a sheet is open or there is a page to go back
 * to) and receives the gesture: started, progress (0 to 1), cancelled, invoked. Before Android 14
 * only `invoked` arrives. On the web there is no plugin: the browser handles back itself.
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { isNative } from './platform';

interface BackEvent {
  /** 0 = swiped in from the left edge, 1 = from the right. */
  edge?: number;
  progress?: number;
}

interface PredictiveBackPlugin {
  setEnabled(options: { enabled: boolean }): Promise<void>;
  addListener(
    event: 'backStarted' | 'backProgress' | 'backCancelled' | 'backInvoked',
    cb: (e: BackEvent) => void,
  ): Promise<PluginListenerHandle>;
}

const Plugin = registerPlugin<PredictiveBackPlugin>('PredictiveBack');

/** Turn Android's back callback on or off. Never throws (an older app build has no plugin). */
export function setNativeBackEnabled(enabled: boolean): void {
  if (!isNative) return;
  Plugin.setEnabled({ enabled }).catch(() => undefined);
}

export interface BackSink {
  started(edge: number | undefined): void;
  progress(p: number, edge: number | undefined): void;
  cancelled(): void;
  invoked(): void;
}

/** Name of the window event that stands in for the plugin where there is none (tests, the web). */
export const BACK_TEST_EVENT = 'gauntlet:predictive-back';
export interface BackTestDetail extends BackEvent {
  type: 'started' | 'progress' | 'cancelled' | 'invoked';
}

/** Send the plugin's events to `sink`; returns the function that stops listening. */
export function listenForBack(sink: BackSink): () => void {
  if (!isNative) {
    // Only for end-to-end tests: a real browser never sends this.
    const on = (e: Event) => {
      const d = (e as CustomEvent<BackTestDetail>).detail;
      if (d.type === 'started') sink.started(d.edge);
      else if (d.type === 'progress') sink.progress(d.progress ?? 0, d.edge);
      else if (d.type === 'cancelled') sink.cancelled();
      else if (d.type === 'invoked') sink.invoked();
    };
    window.addEventListener(BACK_TEST_EVENT, on);
    return () => window.removeEventListener(BACK_TEST_EVENT, on);
  }
  const subs = [
    Plugin.addListener('backStarted', (e) => sink.started(e.edge)),
    Plugin.addListener('backProgress', (e) => sink.progress(e.progress ?? 0, e.edge)),
    Plugin.addListener('backCancelled', () => sink.cancelled()),
    Plugin.addListener('backInvoked', () => sink.invoked()),
  ];
  return () => subs.forEach((s) => s.then((h) => h.remove()).catch(() => undefined));
}
