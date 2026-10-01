import { formatMetricValue, type ChallengeSummary } from '@gauntlet/shared';

export function fmt(value: number | null | undefined, c: Pick<ChallengeSummary, 'decimals' | 'unit'>, withUnit = true) {
  return formatMetricValue(value, c, withUnit);
}

export function fmtInt(value: number | null | undefined) {
  return value == null ? '–' : Math.round(value).toLocaleString('en-US');
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]![0]}.` : name;
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

export function dateRange(start: string, end: string): string {
  const o: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  const a = new Date(`${start}T00:00:00Z`).toLocaleDateString('en-US', o);
  const b = new Date(`${end}T00:00:00Z`).toLocaleDateString('en-US', o);
  return start === end ? a : `${a} – ${b}`;
}

export function daysLeftText(c: Pick<ChallengeSummary, 'status' | 'daysLeft' | 'startDate'>): string {
  if (c.status === 'completed') return 'Final';
  if (c.status === 'upcoming') return `Starts ${dateRange(c.startDate, c.startDate)}`;
  return c.daysLeft === 1 ? 'Last day' : `${c.daysLeft} days left`;
}
