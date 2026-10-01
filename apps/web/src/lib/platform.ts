import { Capacitor } from '@capacitor/core';

export const isNative = Capacitor.isNativePlatform();
export const platform = Capacitor.getPlatform();
export const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');
export const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/**
 * Direct mode talks to SparkyFitness itself, so it only works where CORS doesn't apply: the Android
 * app (native HTTP). A browser build can opt in for end-to-end tests against a CORS-friendly fake.
 */
export const DIRECT_AVAILABLE = isNative || import.meta.env.VITE_ALLOW_DIRECT_IN_BROWSER === '1';
export const DEFAULT_SPARKY_URL = (
  import.meta.env.VITE_SPARKY_URL ?? 'https://fit.randalls.cc'
).replace(/\/+$/, '');
/** Gauntlet server pre-filled on the Android login screen (optional). */
export const DEFAULT_SERVER_URL = API_BASE;
