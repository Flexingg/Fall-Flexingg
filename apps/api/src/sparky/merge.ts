/**
 * SparkyFitness stores the same metric in different places depending on where
 * it came from (wearable daily summaries, phone check-ins, custom measurement
 * categories, exercise entries). This module turns those raw rows into one
 * value per day and metric.
 *
 * Rules:
 * - Cumulative metrics (steps, distance, calories, active minutes) take the
 *   highest value any single source reports for the day. Sources overlap (a
 *   watch and a phone both count the same walk), so they are never added.
 * - Workouts are counted from exercise entries only.
 * - Sleep takes the source with the most sleep that night.
 * - Resting heart rate prefers wearable daily summaries, then measurements.
 */
import type { MetricAggregate } from '@gauntlet/shared';
import type {
  CheckInRow,
  CustomCategory,
  CustomMeasurementRow,
  DailyHealthRow,
  ExerciseDayBucket,
  ExerciseEntryRow,
  SleepRow,
} from './client.js';

export interface MergedValue {
  date: string;
  metric: string;
  value: number;
  source: string | null;
}

export interface MergeInput {
  start: string;
  end: string;
  daily: DailyHealthRow[];
  checkIns: CheckInRow[];
  /** Custom measurement rows keyed by category name. */
  custom: Record<string, { category: CustomCategory; rows: CustomMeasurementRow[] }>;
  exerciseDays: ExerciseDayBucket[];
  exerciseEntries: ExerciseEntryRow[];
  sleep: SleepRow[];
  /** Custom metrics wanted by the user's challenges: name (lower case) -> aggregate. */
  customMetrics: Record<string, MetricAggregate>;
}

/** Custom categories SparkyFitness' own phone sync and integrations create for built-in metrics. */
export const DISTANCE_CATEGORIES = ['distance'];
export const RESTING_HR_CATEGORIES = [
  'resting_heart_rate',
  'resting heart rate',
  'restingheartrate',
];
export const ACTIVE_CALORIES_ENTRY = 'active calories';

export function wantedCategoryNames(customMetrics: Record<string, MetricAggregate>): string[] {
  return [...DISTANCE_CATEGORIES, ...RESTING_HR_CATEGORIES, ...Object.keys(customMetrics)];
}

type Candidate = { value: number; source: string | null };

class DayTable {
  private readonly map = new Map<string, Map<string, Candidate[]>>();

  constructor(
    private readonly start: string,
    private readonly end: string,
  ) {}

  add(date: string | null | undefined, metric: string, value: unknown, source: string | null) {
    const d = normDate(date);
    const v = num(value);
    if (!d || d < this.start || d > this.end || v == null) return;
    let byMetric = this.map.get(d);
    if (!byMetric) this.map.set(d, (byMetric = new Map()));
    const list = byMetric.get(metric) ?? [];
    list.push({ value: v, source });
    byMetric.set(metric, list);
  }

  collect(pick: (metric: string, candidates: Candidate[]) => Candidate | null): MergedValue[] {
    const out: MergedValue[] = [];
    for (const [date, byMetric] of this.map) {
      for (const [metric, candidates] of byMetric) {
        const chosen = pick(metric, candidates);
        if (chosen) out.push({ date, metric, value: round(chosen.value), source: chosen.source });
      }
    }
    return out.sort((a, b) =>
      a.date === b.date ? a.metric.localeCompare(b.metric) : a.date.localeCompare(b.date),
    );
  }
}

export function mergeDaily(input: MergeInput): MergedValue[] {
  const t = new DayTable(input.start, input.end);

  // Wearable daily summaries (Garmin, Polar, ...).
  for (const row of input.daily) {
    const src = row.source_provider ?? 'wearable';
    if (pos(row.total_steps)) t.add(row.entry_date, 'steps', row.total_steps, src);
    if (pos(row.total_distance_meters))
      t.add(row.entry_date, 'distance', num(row.total_distance_meters)! / 1000, src);
    if (pos(row.active_calories))
      t.add(row.entry_date, 'active_calories', row.active_calories, src);
    const minutes =
      num(row.exercise_minutes) ??
      (row.moderate_intensity_minutes != null || row.vigorous_intensity_minutes != null
        ? (num(row.moderate_intensity_minutes) ?? 0) + (num(row.vigorous_intensity_minutes) ?? 0)
        : null);
    if (pos(minutes)) t.add(row.entry_date, 'active_minutes', minutes, src);
    if (pos(row.resting_heart_rate))
      t.add(row.entry_date, 'resting_hr_daily', row.resting_heart_rate, src);
  }

  // Check-ins (phone sync, Fitbit, Withings). Newest row per day wins.
  const latestCheckIn = new Map<string, CheckInRow>();
  for (const row of input.checkIns) {
    const d = normDate(row.entry_date);
    if (!d) continue;
    const prev = latestCheckIn.get(d);
    if (!prev || (row.updated_at ?? '') > (prev.updated_at ?? '')) latestCheckIn.set(d, row);
  }
  for (const [d, row] of latestCheckIn) {
    if (pos(row.steps)) t.add(d, 'steps', row.steps, 'check-in');
  }

  // Custom measurement categories.
  for (const [name, { category, rows }] of Object.entries(input.custom)) {
    const key = name.toLowerCase();
    const label = category.display_name || category.name;
    if (DISTANCE_CATEGORIES.includes(key)) {
      for (const [d, v] of dailyCustom(rows, category, 'sum'))
        t.add(d, 'distance', v / 1000, label);
    } else if (RESTING_HR_CATEGORIES.includes(key)) {
      for (const [d, v] of dailyCustom(rows, category, 'avg'))
        t.add(d, 'resting_hr_measured', v, label);
    }
    const agg = input.customMetrics[key];
    if (agg) {
      for (const [d, v] of dailyCustom(rows, category, agg)) t.add(d, `custom:${key}`, v, label);
    }
  }

  // Workouts.
  for (const b of input.exerciseDays) {
    if (pos(b.workoutCount)) t.add(b.startDate, 'workouts', b.workoutCount, 'workouts');
    if (pos(b.durationMinutes)) t.add(b.startDate, 'active_minutes', b.durationMinutes, 'workouts');
    if (pos(b.distanceMeters)) t.add(b.startDate, 'distance', b.distanceMeters / 1000, 'workouts');
    if (pos(b.caloriesBurned)) t.add(b.startDate, 'active_calories', b.caloriesBurned, 'workouts');
  }

  // Phone-synced whole-day active calories arrive as "Active Calories" exercise entries.
  const activeCal = new Map<string, number>();
  for (const e of input.exerciseEntries) {
    if ((e.exercise_name ?? '').trim().toLowerCase() !== ACTIVE_CALORIES_ENTRY) continue;
    const d = normDate(e.entry_date);
    const v = num(e.calories_burned);
    if (d && v != null) activeCal.set(d, (activeCal.get(d) ?? 0) + v);
  }
  for (const [d, v] of activeCal) if (v > 0) t.add(d, 'active_calories', v, 'Health Connect');

  // Sleep: total per source per night, then the biggest source.
  const sleepBySource = new Map<string, number>();
  for (const s of input.sleep) {
    const d = normDate(s.entry_date);
    const secs = num(s.time_asleep_in_seconds) || num(s.duration_in_seconds);
    if (!d || !secs) continue;
    const key = `${d}|${s.source ?? 'sleep'}`;
    sleepBySource.set(key, (sleepBySource.get(key) ?? 0) + secs);
  }
  for (const [key, secs] of sleepBySource) {
    const [d, src] = key.split('|') as [string, string];
    t.add(d, 'sleep', secs / 3600, src);
  }

  const merged = t.collect((metric, cands) => {
    if (metric === 'resting_hr_daily' || metric === 'resting_hr_measured') return cands[0] ?? null;
    if (metric.startsWith('custom:')) return cands[0] ?? null;
    return cands.reduce((best, c) => (c.value > best.value ? c : best));
  });

  // Resting HR: wearable daily summary first, otherwise the measured category.
  const out: MergedValue[] = [];
  const restingDaily = new Set(
    merged.filter((m) => m.metric === 'resting_hr_daily').map((m) => m.date),
  );
  for (const m of merged) {
    if (m.metric === 'resting_hr_daily') out.push({ ...m, metric: 'resting_hr' });
    else if (m.metric === 'resting_hr_measured') {
      if (!restingDaily.has(m.date)) out.push({ ...m, metric: 'resting_hr' });
    } else out.push(m);
  }
  return out;
}

/** Reduce custom measurement rows to one value per day. */
function dailyCustom(
  rows: CustomMeasurementRow[],
  category: CustomCategory,
  aggregate: MetricAggregate,
): Map<string, number> {
  const groups = new Map<string, { value: number; ts: string }[]>();
  for (const r of rows) {
    const d = normDate(r.date);
    const v = num(r.value);
    if (!d || v == null) continue;
    const list = groups.get(d) ?? [];
    list.push({ value: v, ts: r.timestamp ?? String(r.hour ?? '') });
    groups.set(d, list);
  }
  const out = new Map<string, number>();
  const once = (category.frequency ?? '').toLowerCase() === 'daily';
  for (const [d, list] of groups) {
    if (once) {
      // One reading per day: the latest wins.
      out.set(d, list.reduce((a, b) => (b.ts > a.ts ? b : a)).value);
    } else {
      const sum = list.reduce((a, b) => a + b.value, 0);
      out.set(d, aggregate === 'sum' ? sum : sum / list.length);
    }
  }
  return out;
}

function normDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function num(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : null;
}

function pos(value: unknown): boolean {
  const n = num(value);
  return n != null && n > 0;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
