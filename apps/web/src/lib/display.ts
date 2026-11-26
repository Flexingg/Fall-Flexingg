/**
 * The person's display settings (metric/imperial, 12/24-hour clock, number format) as one small
 * store, so the plain formatting helpers in format.ts can read them without every screen passing
 * them around. Order of precedence: what is saved on the account, then what this browser remembers
 * (the shared demo account can't save, so its choices live here), then the device's own locale.
 */
import {
  displayDefaultsFor,
  resolveDisplay,
  type DisplayPrefs,
  type UserSettings,
} from '@gauntlet/shared';
import { useSyncExternalStore } from 'react';
import { deviceLocale } from './platform';

const LOCAL_KEY = 'gauntlet.display';

export const deviceDisplay = (): DisplayPrefs => displayDefaultsFor(deviceLocale);

type Chosen = Partial<Pick<UserSettings, 'units' | 'clock' | 'locale'>>;

function readLocal(): Chosen {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? (JSON.parse(raw) as Chosen) : {};
  } catch {
    return {};
  }
}

function writeLocal(c: Chosen) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(c));
  } catch {
    /* private mode */
  }
}

let current: DisplayPrefs = resolveDisplay(readLocal(), deviceDisplay());
const listeners = new Set<() => void>();

export const getDisplay = (): DisplayPrefs => current;

function set(next: DisplayPrefs) {
  if (
    next.units === current.units &&
    next.clock === current.clock &&
    next.locale === current.locale
  )
    return;
  current = next;
  listeners.forEach((l) => l());
}

/** Re-read after sign-in or a settings change: saved account choices win over this browser's. */
export function applyAccountSettings(settings: Partial<Chosen> | null | undefined) {
  const base = resolveDisplay(readLocal(), deviceDisplay());
  set(resolveDisplay(settings ?? {}, base));
}

/** A choice made on this device (always remembered here, and saved to the account by the caller). */
export function chooseDisplay(patch: Chosen) {
  const merged = { ...readLocal(), ...patch };
  writeLocal(merged);
  set(resolveDisplay(patch, current));
}

/** Re-renders a component whenever the display settings change. */
export function useDisplay(): DisplayPrefs {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getDisplay,
    getDisplay,
  );
}
