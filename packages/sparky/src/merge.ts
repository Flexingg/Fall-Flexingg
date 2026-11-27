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
import {
  adherenceScore,
  DEFAULT_PRIORITY_KEY,
  DEFAULT_DISPLAY,
  epley1rm,
  formatFlexible,
  formatQuantityFlexible,
  HEALTH_CATEGORY_NAMES,
  healthMetricOfCategory,
  HEALTH_METRICS,
  isHealthMetric,
  todayIn,
  type DisplayPrefs,
  type ChallengeEvent,
  type HealthMetricDef,
  type MergeRule,
  type MetricAggregate,
  type MetricDetail,
} from '@gauntlet/shared';
import type {
  CheckInRow,
  CustomCategory,
  CustomMeasurementRow,
  DailyHealthRow,
  ExerciseDayBucket,
  ExerciseEntryRow,
  ExerciseSetRow,
  FastRow,
  GoalsRow,
  NutritionDayRow,
  SleepRow,
  WaterRow,
} from './client.js';

export interface MergedValue {
  date: string;
  metric: string;
  value: number;
  source: string | null;
  /** Every source's value for the day and why the stored one won (see MetricDetail). */
  detail?: MetricDetail;
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
  /** Food totals per day (days with food logged). */
  nutrition?: NutritionDayRow[];
  water?: WaterRow[];
  /** The person's goals per day, where known. Adherence is only scored on these days. */
  goals?: Record<string, GoalsRow>;
  fasts?: FastRow[];
  /** Exercises (lower case) wanted for per-exercise strength metrics. */
  lifts?: string[];
  /** The person's time zone, to put a fast on the day it ended. Defaults to UTC. */
  timezone?: string;
  /**
   * Preferred sources per metric (source keys, see sourceKey), most preferred first. A day uses the
   * first listed source that has a value; days none of them cover fall back to the usual rule.
   * The reserved key DEFAULT_PRIORITY_KEY ("*") is the order for every metric with no list of its own.
   */
  priorities?: Record<string, string[]>;
}

/** Metrics more than one source commonly reports, where a person can pick which one counts. */
export const PRIORITY_METRICS = [
  'steps',
  'distance',
  'active_calories',
  'active_minutes',
  'sleep',
  'resting_hr',
] as const;
export type PriorityMetric = (typeof PRIORITY_METRICS)[number];

/**
 * SparkyFitness labels data by where it stored it, not by device. Fold those labels into sources a
 * person recognises: the provider (garmin, polar, ...), "health_connect" for what phone sync writes
 * (check-ins, its Distance / resting heart rate categories, "Health Connect" entries), and
 * "workouts" for logged exercise.
 */
export function sourceKey(raw: string | null | undefined): string {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (
    s === 'check-in' ||
    s === 'health connect' ||
    s === 'healthconnect' ||
    s === 'health_connect' ||
    s === 'apple health' ||
    DISTANCE_CATEGORIES.includes(s) ||
    RESTING_HR_CATEGORIES.includes(s)
  )
    return 'health_connect';
  if (s === 'workouts') return s;
  // Data typed into SparkyFitness itself carries no provider. "wearable" is what older Gauntlet
  // versions called it, so stored priorities that name it keep working.
  if (s === 'wearable' || s === 'manual' || s === 'sparkyfitness') return 'sparkyfitness';
  return s.replace(/\s+/g, '_');
}

const SOURCE_LABELS: Record<string, string> = {
  garmin: 'Garmin',
  fitbit: 'Fitbit',
  polar: 'Polar',
  oura: 'Oura',
  coros: 'COROS',
  withings: 'Withings',
  strava: 'Strava',
  health_connect: 'Health Connect & phone',
  workouts: 'Logged workouts',
  sparkyfitness: 'SparkyFitness',
  demo: 'Demo',
};

export function sourceLabel(key: string): string {
  return SOURCE_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

export interface MergeResult {
  values: MergedValue[];
  /** For each PRIORITY_METRICS metric: the source keys that reported something in the window. */
  sources: Record<string, string[]>;
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
  return [
    ...DISTANCE_CATEGORIES,
    ...RESTING_HR_CATEGORIES,
    ...HEALTH_CATEGORY_NAMES,
    ...Object.keys(customMetrics),
  ];
}

/** Lower rank wins first; within a rank the highest value wins. */
type Candidate = {
  value: number;
  source: string | null;
  rank: number;
  /** Worked out from many entries (food totals, workouts, sets...) rather than read as-is. */
  combined: boolean;
};

/** A winner and why it won. */
interface Decision {
  winner: Candidate;
  rule: MergeRule;
  order?: 'metric' | 'default';
}

class DayTable {
  private readonly map = new Map<string, Map<string, Candidate[]>>();

  constructor(
    private readonly start: string,
    private readonly end: string,
  ) {}

  add(
    date: string | null | undefined,
    metric: string,
    value: unknown,
    source: string | null,
    rank = 0,
    combined = false,
  ) {
    const d = normDate(date);
    const v = num(value);
    if (!d || d < this.start || d > this.end || v == null) return;
    let byMetric = this.map.get(d);
    if (!byMetric) this.map.set(d, (byMetric = new Map()));
    const list = byMetric.get(metric) ?? [];
    list.push({ value: v, source, rank, combined });
    byMetric.set(metric, list);
  }

  /** Every source key seen per metric. */
  sourcesSeen(metrics: readonly string[]): Record<string, string[]> {
    const seen: Record<string, Set<string>> = {};
    for (const byMetric of this.map.values())
      for (const m of metrics)
        for (const c of byMetric.get(m) ?? []) (seen[m] ??= new Set()).add(sourceKey(c.source));
    return Object.fromEntries(Object.entries(seen).map(([m, set]) => [m, [...set].sort()]));
  }

  collect(pick: (metric: string, candidates: Candidate[]) => Decision | null): MergedValue[] {
    const out: MergedValue[] = [];
    for (const [date, byMetric] of this.map) {
      for (const [metric, candidates] of byMetric) {
        const d = pick(metric, candidates);
        if (d) out.push(toMerged(date, metric, candidates, d));
      }
    }
    return out.sort((a, b) =>
      a.date === b.date ? a.metric.localeCompare(b.metric) : a.date.localeCompare(b.date),
    );
  }
}

export function mergeDaily(input: MergeInput): MergedValue[] {
  return mergeDailyDetailed(input).values;
}

/**
 * The stored value with its explanation: one candidate per source (the winner's own value for its
 * source, otherwise that source's highest), and the rule. Several readings from one source (every
 * set of a lift, every row of a category) are one candidate, so a single source is just `only`.
 */
function toMerged(date: string, metric: string, all: Candidate[], d: Decision): MergedValue {
  const bySource = new Map<string | null, number>();
  for (const c of all)
    bySource.set(c.source, Math.max(bySource.get(c.source) ?? -Infinity, c.value));
  bySource.set(d.winner.source, d.winner.value);
  const candidates = [...bySource].map(([source, value]) => ({ source, value: round(value) }));
  let rule = d.rule;
  let order = d.order;
  if (candidates.length === 1) {
    rule = d.winner.combined ? 'combined' : 'only';
    order = undefined;
  }
  return {
    date,
    metric,
    value: round(d.winner.value),
    source: d.winner.source,
    detail: { rule, candidates, ...(order ? { order } : {}) },
  };
}

/** The usual winner among candidates: lowest rank, then the highest value. */
const highest = (cands: Candidate[]) =>
  cands.reduce((best, c) =>
    c.rank < best.rank || (c.rank === best.rank && c.value > best.value) ? c : best,
  );

export function mergeDailyDetailed(input: MergeInput): MergeResult {
  const t = new DayTable(input.start, input.end);

  // Wearable daily summaries (Garmin, Polar, ...).
  for (const row of input.daily) {
    const src = row.source_provider || 'sparkyfitness';
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
      t.add(row.entry_date, 'resting_hr', row.resting_heart_rate, src, 0);
    // Health Connect readings SparkyFitness keeps in the daily summary (0.17). Total calories is a
    // dedicated field there; floors, VO2 max and resting energy are backups for the custom
    // measurement / check-in the phone also writes (rank 1, so those win when present).
    if (pos(row.total_calories)) t.add(row.entry_date, 'total_calories', row.total_calories, src);
    if (pos(row.floors_ascended)) t.add(row.entry_date, 'floors', row.floors_ascended, src);
    if (pos(row.vo2_max)) t.add(row.entry_date, 'vo2_max', row.vo2_max, src, 1);
    if (pos(row.bmr_calories)) t.add(row.entry_date, 'bmr', row.bmr_calories, src, 1);
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
    // Body fat, height and resting energy: SparkyFitness files them as check-in measurements.
    if (pos(row.body_fat_percentage)) t.add(d, 'body_fat', row.body_fat_percentage, 'check-in');
    if (pos(row.height)) t.add(d, 'height', row.height, 'check-in');
    if (pos(row.bmr)) t.add(d, 'bmr', row.bmr, 'check-in');
  }

  // Custom measurement categories.
  for (const [name, { category, rows }] of Object.entries(input.custom)) {
    const key = name.toLowerCase();
    const label = category.display_name || category.name;
    if (DISTANCE_CATEGORIES.includes(key)) {
      for (const [d, v] of dailyCustom(rows, category, 'sum'))
        t.add(d, 'distance', v / 1000, label);
    } else if (RESTING_HR_CATEGORIES.includes(key)) {
      for (const [d, v] of dailyCustom(rows, category, 'avg')) t.add(d, 'resting_hr', v, label, 1);
    }
    const health = healthMetricOfCategory(key);
    if (health) {
      const def = HEALTH_METRICS[health] as HealthMetricDef;
      for (const [d, v] of dailyCustom(rows, category, def.aggregate)) t.add(d, health, v, label);
    }
    const agg = input.customMetrics[key];
    if (agg) {
      for (const [d, v] of dailyCustom(rows, category, agg)) t.add(d, `custom:${key}`, v, label);
    }
  }

  // Workouts: counted from individual entries, with duplicates and stuck sessions removed.
  for (const [d, list] of cleanWorkouts(input.exerciseEntries)) {
    t.add(d, 'workouts', list.length, 'workouts', 0, true);
    const minutes = list.reduce((a, w) => a + w.minutes, 0);
    if (minutes > 0) t.add(d, 'active_minutes', Math.min(minutes, 1440), 'workouts', 2, true);
    const kcal = list.reduce((a, w) => a + w.kcal, 0);
    if (kcal > 0) t.add(d, 'active_calories', kcal, 'workouts', 2, true);
  }
  // Workout distance comes from SparkyFitness' per-day exercise stats.
  for (const b of input.exerciseDays) {
    if (pos(b.distanceMeters)) t.add(b.startDate, 'distance', b.distanceMeters / 1000, 'workouts');
  }

  // Phone-synced whole-day active calories arrive as "Active Calories" exercise entries.
  const activeCal = new Map<string, number>();
  for (const e of input.exerciseEntries) {
    if ((e.exercise_name ?? '').trim().toLowerCase() !== ACTIVE_CALORIES_ENTRY) continue;
    const d = normDate(e.entry_date);
    const v = num(e.calories_burned);
    if (d && v != null) activeCal.set(d, (activeCal.get(d) ?? 0) + v);
  }
  for (const [d, v] of activeCal)
    if (v > 0) t.add(d, 'active_calories', v, 'Health Connect', 1, true);

  // Sleep: total per source per night, then the biggest source.
  const sleepBySource = new Map<string, number>();
  for (const s of input.sleep) {
    const d = normDate(s.entry_date);
    const asleep = num(s.time_asleep_in_seconds);
    const inBed = num(s.duration_in_seconds);
    // Some synced sessions report more time asleep than the session lasted.
    const secs = asleep && inBed ? Math.min(asleep, inBed) : asleep || inBed;
    if (!d || !secs) continue;
    const key = `${d}|${s.source ?? 'sleep'}`;
    sleepBySource.set(key, (sleepBySource.get(key) ?? 0) + secs);
  }
  for (const [key, secs] of sleepBySource) {
    const [d, src] = key.split('|') as [string, string];
    t.add(d, 'sleep', secs / 3600, src);
  }

  addNutrition(t, input);
  addStrength(t, input);
  addFasting(t, input);
  // Weigh-ins: newest check-in per day. Only ever used for % toward a person's own target.
  for (const [d, row] of latestCheckIn) {
    if (pos(row.weight)) t.add(d, 'weight', row.weight, 'check-in');
  }

  const prio = input.priorities ?? {};
  const values = t.collect((metric, cands) => {
    const only = cands.length === 1 ? cands[0]! : null;
    if (only) return { winner: only, rule: only.combined ? 'combined' : 'only' };
    const own = prio[metric];
    const fallback = (PRIORITY_METRICS as readonly string[]).includes(metric)
      ? prio[DEFAULT_PRIORITY_KEY]
      : undefined;
    const order = (own?.length ? own : fallback)?.map((k) => sourceKey(k));
    if (order?.length) {
      for (const key of order) {
        const mine = cands.filter((c) => sourceKey(c.source) === key);
        if (mine.length)
          return {
            winner: metric === 'resting_hr' ? mine[0]! : highest(mine),
            rule: 'priority',
            order: own?.length ? 'metric' : 'default',
          };
      }
    }
    // Resting HR: the wearable's daily summary first, otherwise a measurement; first one listed.
    if (metric === 'resting_hr') {
      const top = Math.min(...cands.map((c) => c.rank));
      const winner = cands.find((c) => c.rank === top) ?? null;
      return winner ? { winner, rule: 'preferred' } : null;
    }
    if (metric.startsWith('custom:')) return { winner: cands[0]!, rule: 'first' };
    // Health Connect readings: running totals overlap (highest), the rest prefer the first source.
    if (isHealthMetric(metric) && (HEALTH_METRICS[metric] as HealthMetricDef).aggregate !== 'sum') {
      const top = Math.min(...cands.map((c) => c.rank));
      return { winner: cands.find((c) => c.rank === top)!, rule: 'preferred' };
    }
    const winner = highest(cands);
    // A lower rank beat a bigger number: a built-in preference, not the highest.
    return { winner, rule: cands.some((c) => c.rank > winner.rank) ? 'preferred' : 'highest' };
  });
  return { values, sources: t.sourcesSeen(PRIORITY_METRICS) };
}

function addNutrition(t: DayTable, input: MergeInput) {
  const food = new Map<string, { calories: number; protein: number; carbs: number; fat: number }>();
  for (const row of input.nutrition ?? []) {
    const d = normDate(row.date);
    if (!d) continue;
    const day = {
      calories: num(row.calories) ?? 0,
      protein: num(row.protein) ?? 0,
      carbs: num(row.carbs) ?? 0,
      fat: num(row.fat) ?? 0,
    };
    if (!(day.calories > 0 || day.protein > 0 || day.carbs > 0 || day.fat > 0)) continue;
    food.set(d, day);
    t.add(d, 'calories_in', day.calories, 'food', 0, true);
    t.add(d, 'protein', day.protein, 'food', 0, true);
    t.add(d, 'carbs', day.carbs, 'food', 0, true);
    t.add(d, 'fat', day.fat, 'food', 0, true);
  }
  const water = new Map<string, number>();
  for (const row of input.water ?? []) {
    const d = normDate(row.entry_date);
    const ml = num(row.water_ml);
    if (d && ml && ml > 0) water.set(d, (water.get(d) ?? 0) + ml);
  }
  for (const [d, ml] of water) t.add(d, 'water', ml / 1000, 'water', 0, true);

  for (const [d, g] of Object.entries(input.goals ?? {})) {
    const goal = {
      calories: num(g.calories),
      protein: num(g.protein),
      carbs: num(g.carbs),
      fat: num(g.fat),
      water: num(g.water_goal_ml),
    };
    if (pos(goal.calories)) t.add(d, 'goal_calories', goal.calories, 'goals');
    if (pos(goal.protein)) t.add(d, 'goal_protein', goal.protein, 'goals');
    if (pos(goal.carbs)) t.add(d, 'goal_carbs', goal.carbs, 'goals');
    if (pos(goal.fat)) t.add(d, 'goal_fat', goal.fat, 'goals');
    if (pos(goal.water)) t.add(d, 'goal_water', goal.water! / 1000, 'goals');

    // Adherence: only on days something was logged (no log scores nothing, i.e. 0 over a challenge).
    const eaten = food.get(d);
    if (eaten && eaten.calories > 0) {
      const cal = adherenceScore(eaten.calories, goal.calories);
      if (cal != null) t.add(d, 'calorie_adherence', cal, 'food', 0, true);
    }
    if (eaten) {
      const macros = (['protein', 'carbs', 'fat'] as const)
        .map((k) => adherenceScore(eaten[k], goal[k]))
        .filter((v): v is number => v != null);
      if (macros.length)
        t.add(
          d,
          'macro_adherence',
          macros.reduce((a, b) => a + b, 0) / macros.length,
          'food',
          0,
          true,
        );
    }
    const drank = water.get(d);
    if (drank && goal.water && goal.water > 0)
      t.add(d, 'water_goal', Math.min(100, (drank / goal.water) * 100), 'water', 0, true);
  }
}

/** Warm-ups don't count toward strength metrics. */
function isWorkingSet(s: ExerciseSetRow): boolean {
  return !/warm/i.test(s.set_type ?? '') && (num(s.reps) ?? 0) > 0;
}

function addStrength(t: DayTable, input: MergeInput) {
  const wanted = new Set((input.lifts ?? []).map((l) => l.toLowerCase()));
  const volume = new Map<string, number>();
  const sets = new Map<string, number>();
  for (const e of input.exerciseEntries) {
    const d = normDate(e.entry_date);
    if (!d || !e.sets?.length) continue;
    const name = (e.exercise_name ?? '').trim().toLowerCase();
    for (const s of e.sets) {
      if (!isWorkingSet(s)) continue;
      const reps = num(s.reps)!;
      const kg = num(s.weight) ?? 0;
      sets.set(d, (sets.get(d) ?? 0) + 1);
      if (kg > 0) volume.set(d, (volume.get(d) ?? 0) + kg * reps);
      if (kg > 0 && wanted.has(name)) {
        t.add(d, `lift_max:${name}`, kg, e.exercise_source ?? 'workouts');
        t.add(d, `lift_e1rm:${name}`, epley1rm(kg, reps), e.exercise_source ?? 'workouts');
      }
    }
  }
  for (const [d, v] of volume) t.add(d, 'lift_volume', v, 'workouts', 0, true);
  for (const [d, n] of sets) t.add(d, 'lift_sets', n, 'workouts', 0, true);
}

function addFasting(t: DayTable, input: MergeInput) {
  const tz = input.timezone ?? 'UTC';
  const hours = new Map<string, number>();
  const done = new Map<string, number>();
  for (const f of input.fasts ?? []) {
    if ((f.status ?? '').toUpperCase() !== 'COMPLETED' || !f.end_time) continue;
    const end = new Date(f.end_time);
    const start = new Date(f.start_time);
    if (Number.isNaN(end.getTime()) || Number.isNaN(start.getTime())) continue;
    const mins = num(f.duration_minutes) ?? (end.getTime() - start.getTime()) / 60_000;
    if (!(mins > 0)) continue;
    const d = todayIn(tz, end);
    hours.set(d, (hours.get(d) ?? 0) + mins / 60);
    const target = f.target_end_time ? new Date(f.target_end_time) : null;
    if (!target || Number.isNaN(target.getTime()) || end.getTime() >= target.getTime() - 60_000)
      done.set(d, (done.get(d) ?? 0) + 1);
  }
  for (const [d, h] of hours) t.add(d, 'fast_hours', h, 'fasting', 0, true);
  for (const [d, n] of done) t.add(d, 'fasts_completed', n, 'fasting', 0, true);
}

/** A workout longer than this is a session someone forgot to stop. */
const MAX_WORKOUT_MINUTES = 6 * 60;
const MIN_WORKOUT_MINUTES = 3;

export interface CleanWorkout {
  name: string;
  minutes: number;
  kcal: number;
  source: string | null;
  /** The SparkyFitness entry it came from (for the detail view). */
  entry: ExerciseEntryRow;
}

/** Letters, digits, dash and underscore only, so an id is safe in a URL path. */
export const idPart = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '');

/** Each entry's key within its day: SparkyFitness' own id, else its position among that day's entries. */
export function entryKeys(entries: ExerciseEntryRow[]): Map<ExerciseEntryRow, string> {
  const seen = new Map<string, number>();
  const out = new Map<ExerciseEntryRow, string>();
  for (const e of entries) {
    const d = normDate(e.entry_date) ?? '';
    const i = seen.get(d) ?? 0;
    seen.set(d, i + 1);
    out.set(e, (e.id != null && idPart(String(e.id))) || `n${i}`);
  }
  return out;
}

/** Strength entries from one app on one day are one session: its key. */
export const strengthKey = (e: ExerciseEntryRow) =>
  `s-${idPart((e.exercise_source ?? 'log').toLowerCase()) || 'log'}`;

export const hasWorkingSets = (e: ExerciseEntryRow) => (e.sets ?? []).some(isWorkingSet);

/**
 * Real workouts per day: drops SparkyFitness' "Active Calories" entries,
 * sessions too short or too long to be real, and duplicates: the same session
 * written by two apps, sometimes under different activity names, so it is
 * matched on near-identical duration and calories.
 */
export function cleanWorkouts(entries: ExerciseEntryRow[]): Map<string, CleanWorkout[]> {
  const byDay = new Map<string, CleanWorkout[]>();
  for (const e of entries) {
    const name = (e.exercise_name ?? '').trim().toLowerCase();
    if (name === ACTIVE_CALORIES_ENTRY) continue;
    const d = normDate(e.entry_date);
    const minutes = num(e.duration_minutes) ?? 0;
    const kcal = num(e.calories_burned) ?? 0;
    if (!d || minutes < MIN_WORKOUT_MINUTES || minutes > MAX_WORKOUT_MINUTES) continue;
    const list = byDay.get(d) ?? [];
    const dup = list.some(
      (w) =>
        Math.abs(w.minutes - minutes) <= 2 && Math.abs(w.kcal - kcal) <= Math.max(5, kcal * 0.05),
    );
    if (!dup) list.push({ name, minutes, kcal, source: e.exercise_source ?? null, entry: e });
    byDay.set(d, list);
  }
  for (const [d, list] of byDay) if (!list.length) byDay.delete(d);
  return byDay;
}

/** Reduce custom measurement rows to one value per day. */
function dailyCustom(
  rows: CustomMeasurementRow[],
  category: CustomCategory,
  aggregate: MetricAggregate | HealthMetricDef['aggregate'],
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
      const values = list.map((x) => x.value);
      out.set(
        d,
        aggregate === 'sum'
          ? sum
          : aggregate === 'max'
            ? Math.max(...values)
            : aggregate === 'min'
              ? Math.min(...values)
              : aggregate === 'last'
                ? list.reduce((a, b) => (b.ts > a.ts ? b : a)).value
                : sum / list.length,
      );
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

/** Exercises with weighted working sets, most-trained first (for the strength-challenge picker). */
export function liftOptions(
  entries: ExerciseEntryRow[],
): { key: string; label: string; sessions: number }[] {
  const seen = new Map<string, { label: string; sessions: number }>();
  for (const e of entries) {
    const label = (e.exercise_name ?? '').trim();
    const key = label.toLowerCase();
    if (!key || key.length > 60) continue;
    if (!e.sets?.some((s) => isWorkingSet(s) && (num(s.weight) ?? 0) > 0)) continue;
    const prev = seen.get(key);
    seen.set(key, { label: prev?.label ?? label, sessions: (prev?.sessions ?? 0) + 1 });
  }
  return [...seen]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.sessions - a.sessions || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------- events ("what counted")

const titleCase = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/**
 * The workouts, lift sessions and finished fasts behind the daily values, built from the same
 * cleaned data (duplicates and stuck sessions removed, warm-ups left out), so what is listed is
 * exactly what scored.
 */
export function buildEvents(input: {
  start: string;
  end: string;
  exerciseEntries: ExerciseEntryRow[];
  fasts?: FastRow[];
  timezone?: string;
  /** The reader's units and number format (metric / en-US when left out). */
  display?: Pick<DisplayPrefs, 'units' | 'locale'>;
}): { date: string; event: ChallengeEvent }[] {
  const d = input.display ?? DEFAULT_DISPLAY;
  const nf = (n: number, digits = 0) => formatFlexible(n, d, digits);
  const out: { date: string; event: ChallengeEvent }[] = [];
  const inWindow = (d: string) => d >= input.start && d <= input.end;

  const keys = entryKeys(input.exerciseEntries);
  for (const [date, list] of cleanWorkouts(input.exerciseEntries)) {
    if (!inWindow(date)) continue;
    list.forEach((w, i) => {
      const bits = [`${nf(w.minutes)} min`, w.kcal > 0 ? `${nf(w.kcal)} kcal` : ''].filter(Boolean);
      out.push({
        date,
        event: {
          id: `workout:${date}:${i}`,
          kind: 'workout',
          title: titleCase(w.name),
          detail: bits.join(' · '),
          source: w.source,
          workoutId: `${date}.${hasWorkingSets(w.entry) ? strengthKey(w.entry) : keys.get(w.entry)}`,
        },
      });
    });
  }

  let li = 0;
  for (const e of input.exerciseEntries) {
    const date = normDate(e.entry_date);
    if (!date || !inWindow(date)) continue;
    const sets = (e.sets ?? []).filter(isWorkingSet);
    if (!sets.length) continue;
    let top: { kg: number; reps: number } | null = null;
    let volume = 0;
    for (const s of sets) {
      const kg = num(s.weight) ?? 0;
      const reps = num(s.reps) ?? 0;
      volume += kg * reps;
      if (kg > 0 && (!top || kg > top.kg)) top = { kg, reps };
    }
    const bits = [
      `${sets.length} ${sets.length === 1 ? 'set' : 'sets'}`,
      top ? `top ${formatQuantityFlexible(top.kg, 'kg', 1, d)} × ${nf(top.reps)}` : '',
      volume > 0 ? `${formatQuantityFlexible(volume, 'kg', 0, d)} volume` : '',
    ].filter(Boolean);
    out.push({
      date,
      event: {
        id: `lift:${date}:${li++}`,
        kind: 'lift',
        title: titleCase((e.exercise_name ?? 'Lift').trim()),
        detail: bits.join(' · '),
        source: e.exercise_source ?? null,
        workoutId: `${date}.${strengthKey(e)}`,
      },
    });
  }

  const tz = input.timezone ?? 'UTC';
  for (const f of input.fasts ?? []) {
    if ((f.status ?? '').toUpperCase() !== 'COMPLETED' || !f.end_time) continue;
    const end = new Date(f.end_time);
    const start = new Date(f.start_time);
    if (Number.isNaN(end.getTime()) || Number.isNaN(start.getTime())) continue;
    const date = todayIn(tz, end);
    if (!inWindow(date)) continue;
    const mins = num(f.duration_minutes) ?? (end.getTime() - start.getTime()) / 60_000;
    if (!(mins > 0)) continue;
    const target = f.target_end_time ? new Date(f.target_end_time) : null;
    const hit = !target || end.getTime() >= target.getTime() - 60_000;
    const targetH = target ? (target.getTime() - start.getTime()) / 3_600_000 : null;
    out.push({
      date,
      event: {
        id: `fast:${f.id}`,
        kind: 'fast',
        title: f.fasting_type ? `${f.fasting_type} fast` : 'Fast',
        detail: `${nf(mins / 60, 1)} h fasted${
          targetH ? ` · target ${nf(targetH, 1)} h${hit ? '' : ', ended early'}` : ''
        }`,
        source: null,
      },
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
