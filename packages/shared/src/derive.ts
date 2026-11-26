/**
 * Pure functions that turn a person's daily values into what the Today and Trends screens show.
 * Used by the API (rows from its database) and by the Android app's direct mode (rows merged on
 * the phone), so both always agree.
 */
import { addDays, listDates, weekday } from './dates.js';
import { DEFAULT_DISPLAY, formatDistanceKm, formatInt, type DisplayPrefs } from './format.js';
import {
  isBuiltinMetric,
  isCustomMetric,
  isLiftMetric,
  liftExercise,
  METRIC_GROUPS,
  METRICS,
  metricDef,
  type MetricGroup,
} from './metrics.js';
import type {
  TodayResponse,
  TrendDefInfo,
  TrendOverviewItem,
  TrendsOverview,
  TrendsResponse,
} from './api.js';

export interface MetricRow {
  date: string;
  metric: string;
  value: number;
}

/** Daily goals the activity rings are measured against. */
export const DAILY_GOALS = { steps: 10_000, active_calories: 500, active_minutes: 30 } as const;
export const TODAY_METRICS = ['steps', 'active_calories', 'active_minutes', 'distance'] as const;
const STEP_STREAK_TARGET = 10_000;

export function buildToday(
  rows: MetricRow[],
  date: string,
): Pick<TodayResponse, 'date' | 'metrics'> {
  const val = (m: string) => rows.find((r) => r.date === date && r.metric === m)?.value ?? null;
  return {
    date,
    metrics: TODAY_METRICS.map((k) => ({
      key: k,
      label: k === 'active_calories' ? 'Active kcal' : METRICS[k].label,
      value: val(k),
      unit: METRICS[k].unit,
      goal: k in DAILY_GOALS ? DAILY_GOALS[k as keyof typeof DAILY_GOALS] : null,
    })),
  };
}

export type TrendRange = 'day' | 'week' | 'month';

/** First and last day shown for a range: calendar week (Mon-Sun), last 30 days, or last 7 days. */
export function trendWindow(range: TrendRange, today: string): { start: string; end: string } {
  if (range === 'week') {
    const start = addDays(today, -((weekday(today) + 6) % 7));
    return { start, end: addDays(start, 6) };
  }
  if (range === 'month') return { start: addDays(today, -29), end: today };
  return { start: addDays(today, -6), end: today };
}

/** Earliest date buildTrends needs for a range (the period before it is used for comparison). */
export function trendsNeedFrom(range: TrendRange, today: string): string {
  const { start, end } = trendWindow(range, today);
  return addDays(start, -listDates(start, end).length);
}

const titleCase = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/**
 * How a metric looks on the Trends screen: every stat a challenge can be scored on, plus weight
 * (shown only to its owner), each exercise's heaviest set and estimated 1RM, and custom measurements.
 * Null for values that only exist per challenge (weight goal) or aren't a stat (stored goals).
 */
export function trendDef(key: string): TrendDefInfo | null {
  if (key === 'weight')
    return {
      key,
      label: 'Weight',
      unit: 'kg',
      decimals: 1,
      aggregate: 'last',
      group: 'body',
    };
  if (isBuiltinMetric(key)) {
    const d = METRICS[key];
    if (d.transform) return null;
    return {
      key,
      label: d.label,
      unit: d.unit,
      decimals: d.decimals,
      aggregate: d.aggregate === 'sum' ? 'sum' : 'avg',
      group: d.group,
    };
  }
  const lift = liftExercise(key);
  if (lift) {
    return {
      key,
      label: `${titleCase(lift.exercise)} ${lift.prefix === 'lift_max:' ? 'heaviest set' : 'est. 1RM'}`,
      unit: 'kg',
      decimals: 1,
      aggregate: 'max',
      group: 'strength',
    };
  }
  if (isCustomMetric(key))
    return {
      key,
      label: titleCase(key.slice('custom:'.length)),
      unit: '',
      decimals: 1,
      aggregate: 'avg',
      group: 'custom',
    };
  return null;
}

export const isTrendMetric = (key: string): boolean => trendDef(key) != null;

export function buildTrends(opts: {
  rows: MetricRow[];
  range: TrendRange;
  metric: string;
  today: string;
}): Omit<TrendsResponse, 'rankHistory' | 'personalBests'> {
  const { rows, range, metric, today } = opts;
  const def = trendDef(metric) ?? trendDef('steps')!;
  const { start, end } = trendWindow(range, today);
  const span = listDates(start, end).length;
  const prevStart = addDays(start, -span);
  const byDate = new Map(
    rows
      .filter((r) => r.metric === metric && r.date >= prevStart && r.date <= end)
      .map((r) => [r.date, r.value]),
  );
  const agg = (dates: string[]) => {
    const vals = dates.map((d) => byDate.get(d)).filter((v): v is number => v != null);
    if (!vals.length) return 0;
    if (def.aggregate === 'max') return Math.max(...vals);
    if (def.aggregate === 'last') return vals[vals.length - 1]!;
    const sum = vals.reduce((a, b) => a + b, 0);
    return def.aggregate === 'avg' ? sum / vals.length : sum;
  };
  // Compare like with like: only the elapsed part of the current period.
  const elapsed = listDates(start, today < end ? today : end);
  const total = agg(elapsed);
  const previousTotal = agg(listDates(prevStart, addDays(prevStart, elapsed.length - 1)));
  const letters = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  return {
    metric,
    range,
    def,
    total,
    previousTotal,
    changePct: previousTotal > 0 ? ((total - previousTotal) / previousTotal) * 100 : null,
    bars: listDates(start, end).map((d) => ({
      date: d,
      label: range === 'month' ? String(Number(d.slice(8))) : letters[weekday(d)]!,
      value: byDate.get(d) ?? 0,
      isToday: d === today,
    })),
    // Same day-of-period slot, one period earlier: bar i here lines up with bars[i] above.
    previousBars: listDates(start, end).map((_, i) => {
      const date = addDays(prevStart, i);
      return { date, value: byDate.get(date) ?? 0 };
    }),
  };
}

/**
 * Every stat the person has data for, summarised for one range (for the Trends overview), and the
 * full list of stats available to pick from.
 */
export function buildOverview(opts: {
  rows: MetricRow[];
  range: TrendRange;
  today: string;
}): TrendsOverview {
  const { rows, range, today } = opts;
  const keys = [...new Set(rows.map((r) => r.metric))].filter(isTrendMetric);
  const groupOrder = new Map<MetricGroup, number>(METRIC_GROUPS.map((g, i) => [g.key, i]));
  const all = keys
    .map((key) => {
      const t = buildTrends({ rows, range, metric: key, today });
      const item: TrendOverviewItem = {
        ...t.def,
        total: t.total,
        previousTotal: t.previousTotal,
        changePct: t.changePct,
      };
      return item;
    })
    .sort(
      (a, b) =>
        (groupOrder.get(a.group) ?? 99) - (groupOrder.get(b.group) ?? 99) ||
        a.label.localeCompare(b.label),
    );
  return {
    range,
    items: all.filter((i) => i.total > 0 || i.previousTotal > 0),
    available: all.map(({ key, label, unit, group }) => ({ key, label, unit, group })),
  };
}

/**
 * The four "personal bests" tiles. `challengesWon` only exists on a Gauntlet server; without it the
 * last tile shows workouts in the last 30 days instead.
 */
export function personalBests(
  rows: MetricRow[],
  opts: { today: string; challengesWon?: number | null; display?: DisplayPrefs },
): { label: string; value: string }[] {
  const display = opts.display ?? DEFAULT_DISPLAY;
  const max = (metric: string) => {
    const vals = rows.filter((r) => r.metric === metric).map((r) => r.value);
    return vals.length ? Math.max(...vals) : null;
  };
  const distance = max('distance');
  const steps = max('steps');

  const days = rows
    .filter((r) => r.metric === 'steps' && r.value >= STEP_STREAK_TARGET)
    .map((r) => r.date)
    .sort();
  let streak = 0;
  let run = 0;
  let prev: string | null = null;
  for (const date of days) {
    run = prev && addDays(prev, 1) === date ? run + 1 : 1;
    streak = Math.max(streak, run);
    prev = date;
  }

  const last: { label: string; value: string } =
    opts.challengesWon != null
      ? {
          label: 'Challenges won',
          value: `${opts.challengesWon} ${opts.challengesWon === 1 ? 'win' : 'wins'}`,
        }
      : (() => {
          const from = addDays(opts.today, -29);
          const n = rows
            .filter((r) => r.metric === 'workouts' && r.date >= from && r.date <= opts.today)
            .reduce((a, r) => a + r.value, 0);
          return { label: 'Workouts, 30 days', value: formatInt(n, display) };
        })();

  return [
    { label: 'Best distance day', value: formatDistanceKm(distance, display) },
    {
      label: 'Best step day',
      value: formatInt(steps, display),
    },
    { label: '10k-step streak', value: `${streak} ${streak === 1 ? 'day' : 'days'}` },
    last,
  ];
}
