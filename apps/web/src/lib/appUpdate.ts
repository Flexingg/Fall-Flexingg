/**
 * Android app downloads and self-updates. The Gauntlet server keeps a copy of the newest GitHub
 * release's APK (apps/api/src/githubRelease.ts); phones and browsers only ever ask that server.
 */
import { App as CapApp } from '@capacitor/app';
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { AndroidRelease } from '@gauntlet/shared';
import { getApiBase } from './api';
import { DEFAULT_SERVER_URL, isNative, platform } from './platform';

interface AppUpdaterPlugin {
  canInstall(): Promise<{ allowed: boolean }>;
  openInstallSettings(): Promise<void>;
  downloadAndInstall(opts: { url: string; sha256?: string }): Promise<void>;
  addListener(
    event: 'progress',
    fn: (p: { downloaded: number; total: number }) => void,
  ): Promise<PluginListenerHandle>;
}
const AppUpdater = registerPlugin<AppUpdaterPlugin>('AppUpdater');

/** An Android phone using the web app in a browser (not the installed app). */
export const isAndroidBrowser =
  !isNative && typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
export const canSelfUpdate = isNative && platform === 'android';

/**
 * Compare release versions like "v0.9.1" and "0.8.0": positive when a is newer. Anything that isn't
 * plain numbers (e.g. "dev-abc1234") returns null, so dev builds never nag or get "updated".
 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => {
    const m = /^v?(\d+(?:\.\d+)*)$/.exec(v.trim());
    return m ? m[1]!.split('.').map(Number) : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const serverBase = () => getApiBase() || DEFAULT_SERVER_URL;

/** The newest Android release this server has, with absolute download links; null if none. */
export async function fetchLatestRelease(): Promise<AndroidRelease | null> {
  const base = serverBase();
  if (isNative && !base) return null;
  const res = await fetch(`${base}/api/app/android`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Checking for updates failed (${res.status})`);
  const r = (await res.json()) as AndroidRelease;
  const abs = (u: string) => (/^https?:\/\//.test(u) ? u : `${base}${u}`);
  return { ...r, url: abs(r.url), latestUrl: abs(r.latestUrl) };
}

export interface UpdateCheck {
  installed: string;
  latest: AndroidRelease | null;
  /** True when `latest` is newer than what's installed. */
  available: boolean;
}

export async function checkForUpdate(): Promise<UpdateCheck> {
  const [{ version: installed }, latest] = await Promise.all([
    CapApp.getInfo(),
    fetchLatestRelease(),
  ]);
  const cmp = latest ? compareVersions(latest.version, installed) : null;
  return { installed, latest, available: cmp != null && cmp > 0 };
}

export class InstallPermissionNeeded extends Error {
  constructor() {
    super('Allow Gauntlet to install updates, then tap Update again.');
  }
}

/**
 * Download the release and open Android's installer. The first time, Android needs the person to
 * allow installs from Gauntlet: this opens that setting and throws InstallPermissionNeeded.
 */
export async function installUpdate(
  release: AndroidRelease,
  onProgress?: (fraction: number | null) => void,
): Promise<void> {
  const { allowed } = await AppUpdater.canInstall();
  if (!allowed) {
    await AppUpdater.openInstallSettings();
    throw new InstallPermissionNeeded();
  }
  const sub = await AppUpdater.addListener('progress', ({ downloaded, total }) =>
    onProgress?.(total > 0 ? Math.min(1, downloaded / total) : null),
  );
  try {
    // The versioned file never changes, so it always matches the checksum we were given.
    await AppUpdater.downloadAndInstall({ url: release.url, sha256: release.sha256 || undefined });
  } finally {
    await sub.remove();
  }
}
