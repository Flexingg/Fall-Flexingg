/**
 * The Android live wallpaper reads what to draw from the same on-phone key-value store the app
 * already uses (Capacitor Preferences). It runs without the app open, so the app leaves it the
 * latest snapshot; the wallpaper works out the fractions and spots a new day itself.
 */
import type { WallpaperResponse } from '@gauntlet/shared';
import { registerPlugin } from '@capacitor/core';
import { storage } from './storage';

export const WALLPAPER_KEY = 'gauntlet.wallpaper';
const QUALITY_KEY = 'gauntlet.wallpaper.quality';

export type WallpaperQuality = 'max' | 'balanced' | 'saver';

export const QUALITY_OPTIONS: { value: WallpaperQuality; label: string }[] = [
  { value: 'max', label: 'Maximum' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'saver', label: 'Saver' },
];

/** Render scale per quality, matching the wallpaper (it also drops to 24 or 12 fps). */
export const RENDER_SCALE: Record<WallpaperQuality, number> = { max: 1, balanced: 0.7, saver: 0.5 };

interface GalaxyWallpaperPlugin {
  /** Opens the system preview with "Set wallpaper". */
  open(): Promise<void>;
  status(): Promise<{ active: boolean; supported: boolean }>;
}

export const GalaxyWallpaper = registerPlugin<GalaxyWallpaperPlugin>('GalaxyWallpaper');

let published: string | null = null;

/** Hand the wallpaper today's numbers. Skips the write when nothing changed. */
export async function publishWallpaper(data: WallpaperResponse | null): Promise<void> {
  const json = data ? JSON.stringify(data) : null;
  if (json === published) return;
  published = json;
  await storage.set(WALLPAPER_KEY, json);
}

export async function getQuality(): Promise<WallpaperQuality> {
  const q = await storage.get(QUALITY_KEY);
  return q === 'balanced' || q === 'saver' ? q : 'max';
}

export const setQuality = (q: WallpaperQuality) => storage.set(QUALITY_KEY, q);
