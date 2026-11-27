/**
 * App names for the Health Connect origins (0.18). Health Connect only says an app's package name;
 * a small native plugin (AppLabelsPlugin.java) asks Android for the name it shows for that package,
 * so the "where from" sheet and the app picker can say "Sleep as Android" instead of
 * "com.urbandroid.sleep". Only apps Gauntlet is allowed to see are found (see <queries> in the
 * manifest); the rest keep their package name, or the friendly name from healthAppName().
 */
import { registerPlugin } from '@capacitor/core';
import type { HcOrigin } from '@gauntlet/shared';
import { isNative } from './platform';

interface AppLabelsPlugin {
  labels(options: { packages: string[] }): Promise<{ labels: Record<string, string> }>;
}

const AppLabels = registerPlugin<AppLabelsPlugin>('AppLabels');

/** Names already looked up this run (null: asked, Android didn't know it). */
const known = new Map<string, string | null>();

/** Android's names for these packages; any it doesn't know are left out. Never throws. */
export async function lookupAppLabels(packages: string[]): Promise<Record<string, string>> {
  const asked = [...new Set(packages)].filter((p) => p && !known.has(p));
  if (asked.length && isNative) {
    try {
      const { labels } = await AppLabels.labels({ packages: asked });
      for (const p of asked) known.set(p, labels?.[p]?.trim() || null);
    } catch {
      /* an older app build without the plugin: names are optional */
    }
  }
  const out: Record<string, string> = {};
  for (const p of packages) {
    const n = known.get(p);
    if (n) out[p] = n;
  }
  return out;
}

/** Origins with each app's `name` filled in from `labels` (apps it doesn't know are untouched). */
export function withAppNames(origins: HcOrigin[], labels: Record<string, string>): HcOrigin[] {
  return origins.map((o) => ({
    ...o,
    apps: o.apps.map((a) => (labels[a.packageName] ? { ...a, name: labels[a.packageName] } : a)),
  }));
}

/** Fill in app names on the origins the phone sends. Never throws; unnamed apps stay unnamed. */
export async function nameOrigins(origins: HcOrigin[]): Promise<HcOrigin[]> {
  try {
    const packages = origins.flatMap((o) => o.apps.map((a) => a.packageName));
    return withAppNames(origins, await lookupAppLabels(packages));
  } catch {
    return origins;
  }
}
