/**
 * Remembers a fingerprint of what the phone last sent for each record and origin, so the next sync can
 * skip the ones that did not change (most of a week's records are the same on every resume). Keys look
 * like `type|date|extra` so old ones can be dropped by date. A fingerprint is only remembered once the
 * server took the batch it was in, so a failed upload is simply sent again next time.
 */
export type SentMap = Record<string, string>;

/** 32-bit FNV-1a of a string, with the length mixed in (cheap, plenty for "did it change"). */
export function fingerprint(value: unknown): string {
  const s = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(36)}.${s.length.toString(36)}`;
}

const dateOf = (r: Record<string, unknown>): string => {
  const d = r.date ?? r.entry_date;
  if (typeof d === 'string') return d.slice(0, 10);
  return typeof r.timestamp === 'string' ? r.timestamp.slice(0, 10) : '';
};

/** Key of a record: type, day, and the id that tells two same-day records of a type apart. */
export const recordKey = (r: Record<string, unknown> & { type: string }): string =>
  `${r.type}|${dateOf(r)}|${String(r.source_id ?? r.timestamp ?? '')}`;

export const originKey = (o: { metric: string; date: string }): string =>
  `origin:${o.metric}|${o.date}|`;

/** Keys carry the day second; for `origin:` ones strip the prefix first. */
function keyDate(key: string): string {
  return key.split('|')[1] ?? '';
}

export interface Pending<T> {
  item: T;
  key: string;
  print: string;
}

/** The items that differ from what was last sent (all of them when `sendAll`). */
export function changedItems<T>(
  items: T[],
  keyOf: (item: T) => string,
  sent: SentMap,
  sendAll: boolean,
): Pending<T>[] {
  const out: Pending<T>[] = [];
  for (const item of items) {
    const key = keyOf(item);
    const print = fingerprint(item);
    if (sendAll || sent[key] !== print) out.push({ item, key, print });
  }
  return out;
}

/** Remember what was sent, and forget days older than `keepFrom` (a yyyy-mm-dd). */
export function remember(sent: SentMap, done: Pending<unknown>[], keepFrom: string): SentMap {
  const next: SentMap = {};
  for (const [k, v] of Object.entries(sent)) if (keyDate(k) >= keepFrom) next[k] = v;
  for (const p of done) next[p.key] = p.print;
  return next;
}

export function parseSent(raw: string | null): SentMap {
  try {
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as SentMap) : {};
  } catch {
    return {};
  }
}
