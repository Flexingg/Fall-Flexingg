/**
 * Pure functions that turn a person's daily values into what the Today and Trends screens show.
 * Used by the API (rows from its database) and by the Android app's direct mode (rows merged on
 * the phone), so both always agree.
 */
import { addDays, listDates, weekday } from './dates.js';
import { METRICS, metricDef, type MetricKey } from './metrics.js';
import type { TodayResponse, TrendsResponse } from './api.js';

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

export function buildTrends(opts: {
  rows: MetricRow[];
  range: TrendRange;
  metric: MetricKey;
  today: string;
}): Omit<TrendsResponse, 'rankHistory' | 'personalBests'> {
  const { rows, range, metric, today } = opts;
  const { start, end } = trendWindow(range, today);
  const span = listDates(start, end).length;
  const prevStart = addDays(start, -span);
  const byDate = new Map(
    rows
      .filter((r) => r.metric === metric && r.date >= prevStart && r.date <= end)
      .map((r) => [r.date, r.value]),
  );
  const avg = metricDef(metric).aggregate !== 'sum';
  const agg = (dates: string[]) => {
    const vals = dates.map((d) => byDate.get(d)).filter((v): v is number => v != null);
    if (!vals.length) return 0;
    const sum = vals.reduce((a, b) => a + b, 0);
    return avg ? sum / vals.length : sum;
  };
  // Compare like with like: only the elapsed part of the current period.
  const elapsed = listDates(start, today < end ? today : end);
  const total = agg(elapsed);
  const previousTotal = agg(listDates(prevStart, addDays(prevStart, elapsed.length - 1)));
  const letters = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  return {
    metric,
    range,
    total,
    previousTotal,
    changePct: previousTotal > 0 ? ((total - previousTotal) / previousTotal) * 100 : null,
    bars: listDates(start, end).map((d) => ({
      date: d,
      label: range === 'month' ? String(Number(d.slice(8))) : letters[weekday(d)]!,
      value: byDate.get(d) ?? 0,
      isToday: d === today,
    })),
  };
}

/**
 * The four "personal bests" tiles. `challengesWon` only exists on a Gauntlet server; without it the
 * last tile shows workouts in the last 30 days instead.
 */
export function personalBests(
  rows: MetricRow[],
  opts: { today: string; challengesWon?: number | null },
): { label: string; value: string }[] {
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
          return { label: 'Workouts, 30 days', value: String(Math.round(n)) };
        })();

  return [
    { label: 'Best distance day', value: distance != null ? `${distance.toFixed(1)} km` : '–' },
    {
      label: 'Best step day',
      value: steps != null ? Math.round(steps).toLocaleString('en-US') : '–',
    },
    { label: '10k-step streak', value: `${streak} ${streak === 1 ? 'day' : 'days'}` },
    last,
  ];
}
