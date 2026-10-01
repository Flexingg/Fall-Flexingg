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
/** The SparkyFitness that ships with Gauntlet (set per build; empty means "ask"). */
export const DEFAULT_SPARKY_URL = (import.meta.env.VITE_SPARKY_URL ?? '').replace(/\/+$/, '');
/** The Gauntlet server the Android app uses unless someone picks another one. */
export const DEFAULT_SERVER_URL = API_BASE;
