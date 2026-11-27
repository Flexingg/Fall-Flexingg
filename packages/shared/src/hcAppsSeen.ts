/**
 * Which Health Connect apps were seen writing each stat: the same count on the server (from
 * health_origins) and in direct mode (from the origins kept on the phone), so the chooser shows
 * the same thing either way. See hcApps.ts for what choosing apps does.
 */
import type { HcAppSeen } from './hcApps.js';
import { healthAppName, type HcOriginApp } from './statSource.js';

/**
 * Per stat, each app that wrote something on at least one day, with how many days, the device
 * types, and the latest name the phone reported (else a friendly one). Most days first.
 */
export function summariseSeen(
  rows: { date: string; metric: string; apps: HcOriginApp[] }[],
): Record<string, HcAppSeen[]> {
  const byStat = new Map<string, Map<string, HcAppSeen>>();
  // Oldest first, so the latest name wins.
  for (const row of [...rows].sort((a, b) => a.date.localeCompare(b.date))) {
    const apps = byStat.get(row.metric) ?? new Map<string, HcAppSeen>();
    byStat.set(row.metric, apps);
    for (const a of row.apps) {
      if (!(a.value > 0 || a.records > 0)) continue; // listed but wrote nothing that day
      const seen = apps.get(a.packageName) ?? {
        packageName: a.packageName,
        name: healthAppName(a.packageName),
        days: 0,
        devices: [],
      };
      seen.days += 1;
      for (const d of a.devices) if (!seen.devices.includes(d)) seen.devices.push(d);
      if (a.name?.trim()) seen.name = healthAppName(a.packageName, a.name.trim());
      apps.set(a.packageName, seen);
    }
  }
  const out: Record<string, HcAppSeen[]> = {};
  for (const [metric, apps] of byStat) {
    const list = [...apps.values()].sort((a, b) => b.days - a.days || a.name.localeCompare(b.name));
    if (list.length) out[metric] = list;
  }
  return out;
}
