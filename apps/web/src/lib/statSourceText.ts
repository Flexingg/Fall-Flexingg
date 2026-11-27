/**
 * Plain-English wording for the "where did this come from" sheet: why a source counts (from the
 * merge's `rule` and `order`), what an overlap between Health Connect apps means, and small
 * formatting helpers. Pure, so the exact wording is unit tested.
 */
import type { MergeRule, PhoneAppShare, StatSourceResponse } from '@gauntlet/shared';

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

type WhyInput = Pick<
  StatSourceResponse,
  'value' | 'source' | 'rule' | 'order' | 'label' | 'candidates'
>;

/** One or two sentences: which source counts and why. */
export function whyThisSource(r: WhyInput, opts: { direct?: boolean } = {}): string {
  if (r.value == null) return 'Nothing has been recorded for this stat on this day.';
  const src = r.source?.label ?? 'an unknown source';
  const rule: MergeRule | null = r.rule;
  if (!rule) {
    return opts.direct
      ? 'Gauntlet on this phone put this together from the sources you have connected.'
      : r.source
        ? `Counted from ${src}. More detail about why appears after your next sync.`
        : 'Gauntlet did not keep which source this came from. More detail appears after your next sync.';
  }
  const n = r.candidates.length;
  switch (rule) {
    case 'only':
      return `Only ${src} had this.`;
    case 'priority':
      return r.order === 'metric'
        ? `Your source order for ${r.label} puts ${src} first.`
        : `Your default source order puts ${src} first.`;
    case 'highest':
      return `Highest of ${n > 1 ? n : 'your'} sources. The same activity can show up in more than one, so they are never added together.`;
    case 'preferred':
      return `Gauntlet prefers ${src} for this stat.`;
    case 'first':
      return `${src} was the first source to report it.`;
    case 'combined':
      return n > 1
        ? `Worked out by adding up ${n} entries.`
        : 'Worked out by adding up several entries.';
  }
}

/** Whether the person's source order has anything to do with this result. */
export const usesSourceOrder = (r: Pick<StatSourceResponse, 'rule' | 'candidates'>): boolean =>
  r.rule === 'priority' ||
  ((r.rule === 'highest' || r.rule === 'preferred') && r.candidates.length > 1);

/** The Health Connect apps that actually wrote something. */
export const writers = (apps: PhoneAppShare[]) => apps.filter((a) => a.value > 0);

/** Warning for a stat two or more apps wrote, or null. */
export function overlapHint(label: string, apps: PhoneAppShare[]): string | null {
  const names = writers(apps).map((a) => a.name);
  if (names.length < 2) return null;
  const who = names.length === 2 ? `${names[0]} and ${names[1]} both` : `${joinNames(names)} all`;
  return `${who} wrote ${label.toLowerCase()} for this day. Health Connect counts each one only once, using its own app priority. If this looks too high, check Health Connect's data sources.`;
}

export const recordsText = (n: number) => (n === 1 ? '1 record' : `${n} records`);

export const capitalise = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
