/**
 * Direct mode (no Gauntlet server) keeps the phone's Health Connect origins on the phone, so the
 * long-press "where from" sheet works there too. Same shape the server stores (health_origins);
 * re-sent days replace their entries, and anything older than KEEP_DAYS is dropped.
 */
import { addDays, type HcOrigin } from '@gauntlet/shared';
import { storage } from './storage';

export const HC_ORIGINS_KEY = 'gauntlet.direct.hcOrigins';
const KEEP_DAYS = 62;

export type StoredOrigin = HcOrigin & { reportedAt: string };

export async function loadOrigins(): Promise<StoredOrigin[]> {
  try {
    const raw = await storage.get(HC_ORIGINS_KEY);
    return raw ? (JSON.parse(raw) as StoredOrigin[]) : [];
  } catch {
    return [];
  }
}

/** Merge newly read origins in (same day and stat replaces), keeping the last KEEP_DAYS days. */
export async function saveOrigins(
  next: HcOrigin[],
  today: string,
  now = new Date(),
): Promise<void> {
  const cutoff = addDays(today, -KEEP_DAYS);
  const byKey = new Map((await loadOrigins()).map((o) => [`${o.date}|${o.metric}`, o]));
  for (const o of next) byKey.set(`${o.date}|${o.metric}`, { ...o, reportedAt: now.toISOString() });
  const kept = [...byKey.values()].filter((o) => o.date >= cutoff);
  await storage.set(HC_ORIGINS_KEY, JSON.stringify(kept));
}

export async function originFor(date: string, metric: string): Promise<StoredOrigin | null> {
  return (await loadOrigins()).find((o) => o.date === date && o.metric === metric) ?? null;
}
