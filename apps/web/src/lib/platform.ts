import { Capacitor } from '@capacitor/core';

export const isNative = Capacitor.isNativePlatform();
export const platform = Capacitor.getPlatform();
export const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');
export const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
