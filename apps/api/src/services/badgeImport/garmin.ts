/**
 * Reads the community Garmin badge database (garminbadges.com, shared with its owners' blessing).
 * One polite request per run, never their images. Rows are validated one by one: a malformed or
 * oddly shaped row is skipped, unknown fields are ignored. We keep only the text an admin needs to
 * compare against; it is never shown to users.
 */
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { importFetch } from './http.js';

export const GARMIN_USER_AGENT =
  'Gauntlet badge import (+https://github.com/Flexingg/Fall-Flexingg)';

export interface GarminBadge {
  /** garminbadges.com id, as text. */
  id: string;
  name: string;
  description: string;
  /** Category key, e.g. "running". */
  category: string | null;
  /** YYYY-MM-DD */
  start: string | null;
  end: string | null;
}

export const garminBadgeUrl = (id: string) => `https://garminbadges.com/badges/${id}`;

const text = z.string().trim();
const rowSchema = z.object({
  id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  name: text.min(1),
  description: text.nullish(),
  start_date: z.string().nullish(),
  end_date: z.string().nullish(),
  category: z.object({ key: z.string().nullish() }).nullish(),
});

/** "2026-11-29T00:00:00.000000Z" → "2026-11-29"; anything that isn't a real date → null. */
export function garminDate(v: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v ?? '');
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== `${m[1]}-${m[2]}-${m[3]}`
    ? null
    : `${m[1]}-${m[2]}-${m[3]}`;
}

/** Turn whatever the API returned into clean badges. Throws only if it isn't a list at all. */
export function normalizeGarminBadges(raw: unknown): GarminBadge[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)
      ? (raw as { data: unknown[] }).data
      : null;
  if (!list) throw new Error('The Garmin badge list was not in the expected format');
  const seen = new Set<string>();
  const out: GarminBadge[] = [];
  for (const item of list) {
    const p = rowSchema.safeParse(item);
    if (!p.success) continue;
    const id = String(p.data.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: p.data.name.slice(0, 300),
      description: (p.data.description ?? '').slice(0, 2000),
      category: p.data.category?.key?.trim() || null,
      start: garminDate(p.data.start_date),
      end: garminDate(p.data.end_date),
    });
  }
  return out;
}

export async function fetchGarminBadges(ctx: AppContext): Promise<GarminBadge[]> {
  const res = await importFetch(ctx.cfg.GARMIN_BADGES_URL, {
    headers: { 'user-agent': GARMIN_USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`The Garmin badge database answered ${res.status}`);
  return normalizeGarminBadges(await res.json());
}
