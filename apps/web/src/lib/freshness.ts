/**
 * Getting fresh numbers in. Three ways, all through here:
 *  - "Sync now" (Today, Data sources) and pull-to-refresh: send Health Connect (Android), ask every
 *    connected app (Garmin, Fitbit, ...) to pull its latest, and re-read SparkyFitness now. What the
 *    apps bring lands a minute or so later, so the screens look again a few times.
 *  - Coming back to the app or tab after a while: a quick re-read in the background.
 */
import type { SyncResponse } from '@gauntlet/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import { useAuth } from './auth';
import { syncHealthConnect } from './health';
import { isNative } from './platform';
import { syncNow } from './session';
import { toast } from '../components/ui';
import { invalidateSyncedData } from './syncedData';

/** Look again after the apps have had time to pull. */
const FOLLOW_UPS_MS = [15_000, 40_000, 90_000];
/** Coming back to the app re-reads at most this often. */
const AUTO_EVERY_MS = 5 * 60_000;

/** A sync's result, plus whether the phone's Health Connect upload failed (so it isn't "Up to date"). */
export type SyncOutcome = SyncResponse & { healthConnectFailed?: boolean };

let syncing: Promise<SyncOutcome> | null = null;
const listeners = new Set<(busy: boolean) => void>();
const setBusy = (b: boolean) => listeners.forEach((fn) => fn(b));

let followUps: ReturnType<typeof setTimeout>[] = [];
/** Look again a few times; a newer sync replaces the pending looks, and a hidden app skips them. */
function followUp(qc: QueryClient) {
  followUps.forEach(clearTimeout);
  followUps = FOLLOW_UPS_MS.map((ms) =>
    setTimeout(() => {
      if (document.visibilityState !== 'hidden') void invalidateSyncedData(qc);
    }, ms),
  );
}

/** Run a full sync (shared, so a second tap while one is running just waits for it). */
export async function syncEverything(
  qc: QueryClient,
  opts: { healthConnect: boolean },
): Promise<SyncOutcome> {
  if (!syncing) {
    setBusy(true);
    syncing = (async () => {
      // Health Connect first, so the re-read below already includes it.
      let healthConnectFailed = false;
      if (isNative && opts.healthConnect)
        await syncHealthConnect().catch(() => {
          healthConnectFailed = true;
        });
      const r = await syncNow({ providers: true });
      await invalidateSyncedData(qc);
      if (r.pulling.length) followUp(qc);
      return { ...r, healthConnectFailed };
    })().finally(() => {
      syncing = null;
      setBusy(false);
    });
  }
  return syncing;
}

/** A plain-words summary of a sync, for a toast. */
export function describeSync(r: SyncOutcome): string {
  if (!r.ok) return 'Couldn’t reach SparkyFitness. Try again in a minute.';
  if (r.healthConnectFailed)
    return 'Couldn’t send your phone’s Health Connect data. Try again in a minute.';
  const apps = r.pulling;
  const pulling = !apps.length
    ? ''
    : apps.length === 1
      ? `Pulling from ${apps[0]}…`
      : `Pulling from ${apps.slice(0, -1).join(', ')} and ${apps.at(-1)}…`;
  const changed = r.changed
    ? `Updated ${r.changed} ${r.changed === 1 ? 'number' : 'numbers'}.`
    : 'Up to date.';
  return pulling ? `${changed} ${pulling}` : changed;
}

/** The sync button's state and action, shared by every screen that shows one. */
export function useSyncNow() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [busy, setLocal] = useState(!!syncing);
  useEffect(() => {
    listeners.add(setLocal);
    return () => {
      listeners.delete(setLocal);
    };
  }, []);
  const sync = useCallback(
    async (quiet = false) => {
      try {
        const r = await syncEverything(qc, {
          healthConnect: !!user?.settings.healthConnectSync,
        });
        if (!quiet) toast(describeSync(r));
        return r;
      } catch (err) {
        if (!quiet) toast(err instanceof Error ? err.message : 'Sync failed');
        return null;
      }
    },
    [qc, user?.settings.healthConnectSync],
  );
  return { busy, sync };
}

/** Re-read quietly when the app or tab comes back after a while (mounted once, signed in). */
export function AutoRefresh() {
  const qc = useQueryClient();
  const { status } = useAuth();
  const last = useRef(Date.now());
  useEffect(() => {
    if (status !== 'signedIn') return;
    const maybe = () => {
      if (document.visibilityState === 'hidden' || syncing) return;
      if (Date.now() - last.current < AUTO_EVERY_MS) return;
      last.current = Date.now();
      void syncNow({})
        .then(() => invalidateSyncedData(qc))
        .catch(() => undefined);
    };
    document.addEventListener('visibilitychange', maybe);
    const sub = isNative ? CapApp.addListener('resume', maybe) : null;
    return () => {
      document.removeEventListener('visibilitychange', maybe);
      sub?.then((h) => h.remove());
    };
  }, [status, qc]);
  return null;
}
