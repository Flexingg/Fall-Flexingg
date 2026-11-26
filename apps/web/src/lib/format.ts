import {
  displayUnitLabel,
  formatCompact,
  formatDate,
  formatDateRange,
  formatDateTime,
  formatDistanceKm,
  formatFlexible,
  formatInt,
  formatLiftTotalKg,
  formatMetricValue,
  formatNumber,
  formatPercent,
  formatQuantity,
  formatQuantityFlexible,
  formatTime,
  formatWallTime,
  formatWeightKg,
  type ChallengeSummary,
} from '@gauntlet/shared';
import { getDisplay } from './display';

export function fmt(
  value: number | null | undefined,
  c: Pick<ChallengeSummary, 'decimals' | 'unit'>,
  withUnit = true,
) {
  return formatMetricValue(value, c, withUnit, getDisplay());
}

export function fmtInt(value: number | null | undefined) {
  return formatInt(value, getDisplay());
}

/** A number with the person's digit grouping and a fixed number of decimals. */
export const fmtNum = (value: number | null | undefined, decimals = 0) =>
  formatNumber(value, getDisplay(), decimals);

/** Like fmtNum but whole values drop the decimals ("12", "12.5"). */
export const fmtFlex = (value: number | null | undefined, maxDecimals = 1) =>
  formatFlexible(value, getDisplay(), maxDecimals);

/** A stored (metric) value with its unit, in the person's units: km -> mi, kg -> lb, L -> fl oz. */
export const fmtQty = (
  value: number | null | undefined,
  unit: string,
  decimals = 1,
  withUnit = true,
) => formatQuantity(value, unit, decimals, getDisplay(), withUnit);

/** Like fmtQty, but whole values drop their decimals: "3 kg", "3.5 kg". */
export const fmtQtyFlex = (value: number | null | undefined, unit: string, maxDecimals = 1) =>
  formatQuantityFlexible(value, unit, maxDecimals, getDisplay());

export const fmtDistanceKm = (km: number | null | undefined, decimals = 1) =>
  formatDistanceKm(km, getDisplay(), decimals);
export const fmtWeightKg = (kg: number | null | undefined, decimals = 1) =>
  formatWeightKg(kg, getDisplay(), decimals);
export const fmtLiftTotalKg = (kg: number | null | undefined) =>
  formatLiftTotalKg(kg, getDisplay());

/** The unit label to show for a stored unit ("km" -> "mi" for imperial). */
export const unitLabel = (unit: string) => displayUnitLabel(unit, getDisplay().units);

export const fmtCompact = (value: number, decimals = 1) =>
  formatCompact(value, decimals, getDisplay());

/** Time of day in the person's clock ("7:05 PM" / "19:05"). */
export const fmtTime = (value: string | number | Date | null | undefined, timeZone?: string) =>
  formatTime(value, getDisplay(), timeZone);

/** A wall-clock "07:37" as written, in the person's clock. */
export const fmtWallTime = (hhmm: string | null | undefined) => formatWallTime(hhmm, getDisplay());

/** A calendar day (YYYY-MM-DD) or instant, e.g. "Nov 10"; pass Intl options for other shapes. */
export const fmtDate = (
  value: string | number | Date | null | undefined,
  options?: Intl.DateTimeFormatOptions,
  timeZone?: string,
) => formatDate(value, getDisplay(), options, timeZone);

/** "Nov 10, 7:05 PM". */
export const fmtDateTime = (value: string | number | Date | null | undefined) =>
  formatDateTime(value, getDisplay());

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
  return formatDateRange(start, end, getDisplay());
}

export function daysLeftText(
  c: Pick<ChallengeSummary, 'status' | 'daysLeft' | 'startDate'>,
): string {
  if (c.status === 'completed') return 'Final';
  if (c.status === 'upcoming') return `Starts ${dateRange(c.startDate, c.startDate)}`;
  return c.daysLeft === 1 ? 'Last day' : `${c.daysLeft} days left`;
}

/** A solo challenge's number the way it should read: "+12.4%", "4 days", or in the stat's own unit. */
export function fmtSolo(
  value: number | null | undefined,
  valueKind: 'metric' | 'pct' | 'days',
  c: Pick<ChallengeSummary, 'decimals' | 'unit'>,
  withUnit = true,
): string {
  if (value == null || !Number.isFinite(value)) return '–';
  if (valueKind === 'pct') return formatPercent(value, getDisplay(), 1, true);
  if (valueKind === 'days')
    return `${fmtInt(value)}${withUnit ? (Math.round(value) === 1 ? ' day' : ' days') : ''}`;
  return fmt(value, c, withUnit);
}
