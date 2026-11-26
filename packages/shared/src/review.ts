/**
 * Month / year in review and the calendar heatmap: the contract between API and app, plus the pure
 * logic both sides share (period parsing, streaks, weekday pattern, heatmap levels and the week
 * grid). Everything works on plain `YYYY-MM-DD` strings, so it never depends on a time zone.
 */
import { z } from 'zod';
import { addDays, daysBetween, weekday } from './dates.js';
import { RECAP_METRICS, type RecapTotal } from './notifications.js';

// ---------- Periods: "2026-11" (a month) or "2026" (a year) ----------

export interface ReviewPeriod {
  kind: 'month' | 'year';
  /** "2026-11" or "2026". */
  id: string;
  start: string;
  end: string;
  /** The period right before this one (last month, or last year), for comparisons. */
  prev: { id: string; start: string; end: string };
  /** "November 2026" or "2026". */
  label: string;
  /** "October" / "2025": how comparisons read ("12% more steps than October"). */
  prevLabel: string;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
export const monthName = (month: number) => MONTHS[month - 1] ?? '';

const pad = (n: number) => String(n).padStart(2, '0');
const lastDayOf = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** "2026-11-23" -> "2026-11". */
export const monthOf = (date: string) => date.slice(0, 7);

export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
}

/** Parse a review id; null when it is neither a real month nor a plausible year. */
export function parsePeriod(id: string): ReviewPeriod | null {
  const month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(id);
  if (month) {
    const y = Number(month[1]);
    const m = Number(month[2]);
    if (y < 2000 || y > 2100) return null;
    const pm = previousMonth(id);
    const [py, pmm] = pm.split('-').map(Number) as [number, number];
    return {
      kind: 'month',
      id,
      start: `${id}-01`,
      end: `${id}-${pad(lastDayOf(y, m))}`,
      prev: { id: pm, start: `${pm}-01`, end: `${pm}-${pad(lastDayOf(py, pmm))}` },
      label: `${monthName(m)} ${y}`,
      prevLabel: monthName(pmm),
    };
  }
  const year = /^(\d{4})$/.exec(id);
  if (year) {
    const y = Number(year[1]);
    if (y < 2000 || y > 2100) return null;
    return {
      kind: 'year',
      id,
      start: `${y}-01-01`,
      end: `${y}-12-31`,
      prev: { id: String(y - 1), start: `${y - 1}-01-01`, end: `${y - 1}-12-31` },
      label: String(y),
      prevLabel: String(y - 1),
    };
  }
  return null;
}

export const isReviewPeriod = (id: string) => parsePeriod(id) !== null;

/**
 * Which reviews to put in front of someone on `today`: last month's during the first week of a
 * month, and the year's from 1 December to 7 January. Pure, so Today and the tests agree.
 */
export function reviewsToOffer(today: string): { month: string | null; year: string | null } {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  return {
    month: d <= 7 ? previousMonth(monthOf(today)) : null,
    year: m === 12 ? String(y) : m === 1 && d <= 7 ? String(y - 1) : null,
  };
}

// ---------- The review itself ----------

export interface ReviewRecord {
  /** e.g. "Best step day". */
  label: string;
  /** e.g. "20,000" or "12 days". */
  badge: string;
  date: string;
}

export interface ReviewRival {
  userId: string;
  displayName: string;
  /** Finished challenges you were both in. */
  shared: number;
  /** Of those, how many you finished ahead of them / behind them. */
  wins: number;
  losses: number;
}

export interface Review {
  period: string;
  kind: 'month' | 'year';
  label: string;
  prevLabel: string;
  start: string;
  end: string;
  /** The period isn't over yet, so the numbers are still growing. */
  partial: boolean;
  /** False when nothing was recorded in the period. */
  hasData: boolean;
  /** Days with anything recorded. */
  activeDays: number;
  totals: RecapTotal[];
  bestDay: { date: string; steps: number } | null;
  /** Longest run of days with at least `streakTarget` steps. */
  longestStreak: { days: number; start: string; end: string } | null;
  streakTarget: number;
  /** The weekday you move most (needs a couple of weeks of data). */
  weekday: { name: string; avgSteps: number; overallAvg: number } | null;
  /** Year reviews: the month with the most steps. */
  bestMonth: { month: string; label: string; steps: number } | null;
  records: ReviewRecord[];
  challenges: { played: number; won: number; podiums: number };
  rival: ReviewRival | null;
}

export interface ReviewList {
  /** Months with data, newest first ("2026-11"). */
  months: string[];
  /** Years with data, newest first. */
  years: string[];
}

export const STREAK_TARGET = 10_000;

interface Row {
  date: string;
  metric: string;
  value: number;
}

/** Totals for a period and the one before it (same shape as the weekly recap's). */
export function periodTotals(rows: Row[], p: ReviewPeriod): RecapTotal[] {
  return RECAP_METRICS.map((m) => {
    let value = 0;
    let previous = 0;
    for (const r of rows) {
      if (r.metric !== m.key) continue;
      if (r.date >= p.start && r.date <= p.end) value += r.value;
      else if (r.date >= p.prev.start && r.date <= p.prev.end) previous += r.value;
    }
    const round = (v: number) => Math.round(v * 100) / 100;
    return {
      ...m,
      value: round(value),
      previous: round(previous),
      changePct: previous > 0 ? Math.round(((value - previous) / previous) * 100) : null,
    };
  });
}

/** Steps per day inside a range (days with no steps are left out). */
function stepDays(rows: Row[], start: string, end: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows)
    if (r.metric === 'steps' && r.date >= start && r.date <= end && r.value > 0)
      out.set(r.date, r.value);
  return out;
}

export function bestStepDayIn(
  rows: Row[],
  start: string,
  end: string,
): { date: string; steps: number } | null {
  let best: { date: string; steps: number } | null = null;
  for (const [date, steps] of stepDays(rows, start, end))
    if (!best || steps > best.steps) best = { date, steps };
  return best;
}

/** The longest run of consecutive days with at least `target` steps; null when there is none. */
export function longestStepStreak(
  rows: Row[],
  start: string,
  end: string,
  target = STREAK_TARGET,
): { days: number; start: string; end: string } | null {
  const hits = [...stepDays(rows, start, end)].filter(([, v]) => v >= target).map(([d]) => d);
  hits.sort();
  let best: { days: number; start: string; end: string } | null = null;
  let runStart = '';
  let run = 0;
  for (let i = 0; i < hits.length; i++) {
    if (i > 0 && hits[i] === addDays(hits[i - 1]!, 1)) run++;
    else {
      run = 1;
      runStart = hits[i]!;
    }
    if (!best || run > best.days) best = { days: run, start: runStart, end: hits[i]! };
  }
  return best;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const weekdayName = (date: string) => WEEKDAYS[weekday(date)]!;

/** Which weekday has the highest average steps. Needs `minDays` days of data, else null. */
export function weekdayPattern(
  rows: Row[],
  start: string,
  end: string,
  minDays = 14,
): { name: string; avgSteps: number; overallAvg: number } | null {
  const days = stepDays(rows, start, end);
  if (days.size < minDays) return null;
  const sums = Array.from({ length: 7 }, () => ({ total: 0, n: 0 }));
  let total = 0;
  for (const [date, steps] of days) {
    const s = sums[weekday(date)]!;
    s.total += steps;
    s.n++;
    total += steps;
  }
  let best = -1;
  let bestAvg = 0;
  sums.forEach((s, i) => {
    if (s.n && s.total / s.n > bestAvg) {
      best = i;
      bestAvg = s.total / s.n;
    }
  });
  if (best < 0) return null;
  return {
    name: WEEKDAYS[best]!,
    avgSteps: Math.round(bestAvg),
    overallAvg: Math.round(total / days.size),
  };
}

/** The month (of a year's rows) with the most steps. */
export function bestMonthOf(
  rows: Row[],
  p: ReviewPeriod,
): { month: string; label: string; steps: number } | null {
  const by = new Map<string, number>();
  for (const r of rows)
    if (r.metric === 'steps' && r.date >= p.start && r.date <= p.end && r.value > 0)
      by.set(monthOf(r.date), (by.get(monthOf(r.date)) ?? 0) + r.value);
  let best: { month: string; label: string; steps: number } | null = null;
  for (const [month, steps] of by)
    if (!best || steps > best.steps)
      best = { month, label: monthName(Number(month.slice(5))), steps: Math.round(steps) };
  return best;
}

// ---------- Calendar heatmap ----------

/** The daily numbers a heatmap can show. Never body, food or sleep numbers (not on profiles). */
export const HEATMAP_METRICS = [
  { key: 'steps', label: 'Steps', unit: 'steps', decimals: 0 },
  { key: 'distance', label: 'Distance', unit: 'km', decimals: 1 },
  { key: 'active_minutes', label: 'Active minutes', unit: 'min', decimals: 0 },
  { key: 'active_calories', label: 'Active calories', unit: 'kcal', decimals: 0 },
  { key: 'workouts', label: 'Workouts', unit: 'workouts', decimals: 0 },
  { key: 'lift_volume', label: 'Volume lifted', unit: 'kg', decimals: 0 },
  { key: 'lift_sets', label: 'Sets logged', unit: 'sets', decimals: 0 },
  { key: 'fast_hours', label: 'Hours fasted', unit: 'h', decimals: 1 },
] as const;
export type HeatmapMetricKey = (typeof HEATMAP_METRICS)[number]['key'];
export const heatmapMetricKeys = HEATMAP_METRICS.map((m) => m.key) as HeatmapMetricKey[];

export const heatmapQuerySchema = z.object({
  metric: z.enum(heatmapMetricKeys as [HeatmapMetricKey, ...HeatmapMetricKey[]]).default('steps'),
  /** A calendar year; without it, the last 365 days. */
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export interface HeatmapResponse {
  metric: HeatmapMetricKey;
  label: string;
  unit: string;
  decimals: number;
  start: string;
  end: string;
  /** Days with a value above zero, oldest first: [date, value]. Everything else is a rest day. */
  days: [string, number][];
}

/**
 * Where the four steps between the five levels fall: the 25th, 50th and 75th percentile of the
 * days that have a value (so a quiet person's hardest day is as dark as a marathoner's).
 */
export function heatThresholds(values: number[]): [number, number, number] {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return [0, 0, 0];
  const at = (p: number) => v[Math.max(0, Math.ceil(p * v.length) - 1)]!;
  return [at(0.25), at(0.5), at(0.75)];
}

/** 0 = nothing recorded, 1 (lightest) to 4 (your biggest days). */
export function heatLevel(value: number, t: [number, number, number]): 0 | 1 | 2 | 3 | 4 {
  if (!(value > 0)) return 0;
  // Every day the same: all of them are "big".
  if (t[0] === t[2] && value >= t[2]) return 4;
  if (value <= t[0]) return 1;
  if (value <= t[1]) return 2;
  if (value <= t[2]) return 3;
  return 4;
}

export interface WeekGrid {
  /** One entry per week, Monday first; null for days outside the range. */
  weeks: (string | null)[][];
  /** Where each month starts, as a week index. */
  monthLabels: { week: number; label: string }[];
}

const MONTH_ABBR = MONTHS.map((m) => m.slice(0, 3));

/** Lay `start`..`end` out as GitHub does: a column per week, Monday to Sunday down the side. */
export function buildWeekGrid(start: string, end: string): WeekGrid {
  if (end < start) return { weeks: [], monthLabels: [] };
  const first = addDays(start, -((weekday(start) + 6) % 7));
  const count = Math.floor(daysBetween(first, end) / 7) + 1;
  const weeks: (string | null)[][] = [];
  for (let w = 0; w < count; w++) {
    const col: (string | null)[] = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(first, w * 7 + d);
      col.push(date >= start && date <= end ? date : null);
    }
    weeks.push(col);
  }
  const monthLabels: { week: number; label: string }[] = [];
  let lastMonth = '';
  weeks.forEach((col, week) => {
    const firstDay = col.find((c) => c !== null);
    if (!firstDay) return;
    // A month label sits over the first column that holds the 1st (or the very first column).
    const month =
      col.find((c) => c?.endsWith('-01'))?.slice(0, 7) ?? (week === 0 ? monthOf(firstDay) : '');
    if (month && month !== lastMonth) {
      monthLabels.push({ week, label: MONTH_ABBR[Number(month.slice(5)) - 1]! });
      lastMonth = month;
    }
  });
  // Don't squeeze a label for a sliver of a month into the first two columns.
  if (monthLabels.length > 1 && monthLabels[1]!.week - monthLabels[0]!.week < 2)
    monthLabels.shift();
  return { weeks, monthLabels };
}

/** The Monday-first row (0..6) a date sits in. */
export const gridRow = (date: string) => (weekday(date) + 6) % 7;

/** 2,400,000 -> "2.4M", 38,500 -> "38.5k", 412 -> "412". */
export function compactNumber(value: number): string {
  const a = Math.abs(value);
  if (a >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (a >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return Math.round(value).toLocaleString('en-US');
}
