import { DEFAULT_DISPLAY, formatQuantity, type DisplayPrefs } from './format.js';
import type { ScoringMode } from './scoring.js';

/**
 * The metrics a challenge can be scored on. Raw values come from SparkyFitness;
 * the API normalises every source into one value per user, day and metric.
 */

export const BUILTIN_METRICS = [
  // Activity
  'steps',
  'distance',
  'active_minutes',
  'active_calories',
  'workouts',
  'sleep',
  'resting_hr',
  // Strength (sets logged by Liftosaur, Hevy or SparkyFitness)
  'lift_volume',
  'lift_sets',
  // Nutrition (food and water logged in SparkyFitness)
  'calorie_adherence',
  'macro_adherence',
  'water_goal',
  'water',
  'calories_in',
  'protein',
  'carbs',
  'fat',
  // Body
  'weight_goal',
  // Fasting
  'fast_hours',
  'fasts_completed',
] as const;

/** Per-exercise strength metrics: `lift_max:squat`, `lift_e1rm:bench press`. */
export const LIFT_PREFIXES = ['lift_max:', 'lift_e1rm:'] as const;
export type LiftPrefix = (typeof LIFT_PREFIXES)[number];

/**
 * Values stored per day that no challenge is scored on directly: raw weight (only ever used to
 * work out % toward someone's own target, never shown to others) and the person's own goals.
 */
export const HIDDEN_METRICS = [
  'weight',
  'goal_calories',
  'goal_protein',
  'goal_carbs',
  'goal_fat',
  'goal_water',
] as const;

export type BuiltinMetricKey = (typeof BUILTIN_METRICS)[number];
export type CustomMetricKey = `custom:${string}`;
export type LiftMetricKey = `${LiftPrefix}${string}`;
export type MetricKey = BuiltinMetricKey | CustomMetricKey | LiftMetricKey;

/**
 * How a metric's daily values combine over a period: added up, averaged, or the
 * latest value (for running figures such as "% of my weight target").
 */
export type MetricAggregate = 'sum' | 'avg' | 'last';

export type MetricGroup = 'activity' | 'strength' | 'nutrition' | 'body' | 'fasting' | 'custom';

export const METRIC_GROUPS: { key: MetricGroup; label: string }[] = [
  { key: 'activity', label: 'Activity' },
  { key: 'strength', label: 'Strength' },
  { key: 'nutrition', label: 'Nutrition' },
  { key: 'body', label: 'Body' },
  { key: 'fasting', label: 'Fasting' },
  { key: 'custom', label: 'Custom' },
];

/**
 * How a participant's stored daily values become what they're scored on:
 * - weight_goal: raw weight -> % of their own lose/gain target (needs per-person params).
 * - relative: % change from their own starting value (e.g. estimated 1RM), so a beginner and a
 *   veteran compete on improvement, not on absolute strength.
 */
export type MetricTransform = 'weight_goal' | 'relative';

export interface MetricDef {
  key: MetricKey;
  label: string;
  /** Unit shown after values, e.g. "km". Empty for plain counts. */
  unit: string;
  aggregate: MetricAggregate;
  lowerIsBetter: boolean;
  decimals: number;
  icon: MetricIcon;
  group: MetricGroup;
  /** Ways of winning that make sense; the first is the default. */
  scoring: ScoringMode[];
  /** One line for the picker, e.g. "Scored against each person's own goal". */
  hint?: string;
  transform?: MetricTransform;
  /** The stored metric the values come from, when it isn't `key` (weight_goal reads weight). */
  source?: string;
}

export type MetricIcon =
  | 'steps'
  | 'distance'
  | 'timer'
  | 'flame'
  | 'dumbbell'
  | 'moon'
  | 'pulse'
  | 'plus'
  | 'drop'
  | 'fork'
  | 'scale'
  | 'hourglass'
  | 'target';

const ALL_MODES: ScoringMode[] = ['total', 'race_to_goal', 'daily_avg', 'best_day', 'streak'];
const AVG_MODES: ScoringMode[] = ['total', 'daily_avg', 'best_day', 'streak'];
const OWN_GOAL = "Scored against each person's own goal in SparkyFitness";

function def(
  key: BuiltinMetricKey,
  d: Omit<MetricDef, 'key' | 'lowerIsBetter' | 'decimals' | 'scoring'> &
    Partial<Pick<MetricDef, 'lowerIsBetter' | 'decimals' | 'scoring'>>,
): MetricDef {
  return {
    key,
    lowerIsBetter: false,
    decimals: 0,
    scoring: d.aggregate === 'sum' ? ALL_MODES : AVG_MODES,
    ...d,
  };
}

export const METRICS: Record<BuiltinMetricKey, MetricDef> = {
  steps: def('steps', {
    label: 'Steps',
    unit: '',
    aggregate: 'sum',
    icon: 'steps',
    group: 'activity',
  }),
  distance: def('distance', {
    label: 'Distance',
    unit: 'km',
    aggregate: 'sum',
    decimals: 1,
    icon: 'distance',
    group: 'activity',
  }),
  active_minutes: def('active_minutes', {
    label: 'Active min',
    unit: 'min',
    aggregate: 'sum',
    icon: 'timer',
    group: 'activity',
  }),
  active_calories: def('active_calories', {
    label: 'Calories',
    unit: 'kcal',
    aggregate: 'sum',
    icon: 'flame',
    group: 'activity',
  }),
  workouts: def('workouts', {
    label: 'Workouts',
    unit: '',
    aggregate: 'sum',
    icon: 'dumbbell',
    group: 'activity',
  }),
  sleep: def('sleep', {
    label: 'Sleep',
    unit: 'h',
    aggregate: 'avg',
    decimals: 1,
    icon: 'moon',
    group: 'activity',
  }),
  resting_hr: def('resting_hr', {
    label: 'Resting HR',
    unit: 'bpm',
    aggregate: 'avg',
    lowerIsBetter: true,
    icon: 'pulse',
    group: 'activity',
  }),
  lift_volume: def('lift_volume', {
    label: 'Volume lifted',
    unit: 'kg',
    aggregate: 'sum',
    icon: 'dumbbell',
    group: 'strength',
    hint: 'Weight × reps across every working set',
  }),
  lift_sets: def('lift_sets', {
    label: 'Working sets',
    unit: '',
    aggregate: 'sum',
    icon: 'dumbbell',
    group: 'strength',
  }),
  calorie_adherence: def('calorie_adherence', {
    label: 'Calorie goal',
    unit: 'pts',
    aggregate: 'sum',
    icon: 'target',
    group: 'nutrition',
    scoring: ['daily_avg', 'total', 'streak'],
    hint: `${OWN_GOAL}: 100 a day on target, 2 fewer per 1% over or under. Bulking and cutting compete fairly.`,
  }),
  macro_adherence: def('macro_adherence', {
    label: 'Macro goals',
    unit: 'pts',
    aggregate: 'sum',
    icon: 'target',
    group: 'nutrition',
    scoring: ['daily_avg', 'total', 'streak'],
    hint: `${OWN_GOAL}: protein, carbs and fat each scored like calories, then averaged.`,
  }),
  water_goal: def('water_goal', {
    label: 'Water goal',
    unit: '%',
    aggregate: 'sum',
    icon: 'drop',
    group: 'nutrition',
    scoring: ['daily_avg', 'streak', 'total'],
    hint: `${OWN_GOAL}: % of your daily water goal, up to 100.`,
  }),
  water: def('water', {
    label: 'Water',
    unit: 'L',
    aggregate: 'sum',
    decimals: 1,
    icon: 'drop',
    group: 'nutrition',
  }),
  calories_in: def('calories_in', {
    label: 'Calories eaten',
    unit: 'kcal',
    aggregate: 'sum',
    icon: 'fork',
    group: 'nutrition',
  }),
  protein: def('protein', {
    label: 'Protein',
    unit: 'g',
    aggregate: 'sum',
    icon: 'fork',
    group: 'nutrition',
  }),
  carbs: def('carbs', {
    label: 'Carbs',
    unit: 'g',
    aggregate: 'sum',
    icon: 'fork',
    group: 'nutrition',
  }),
  fat: def('fat', { label: 'Fat', unit: 'g', aggregate: 'sum', icon: 'fork', group: 'nutrition' }),
  weight_goal: def('weight_goal', {
    label: 'Weight goal',
    unit: '%',
    aggregate: 'last',
    decimals: 0,
    icon: 'scale',
    group: 'body',
    scoring: ['total', 'race_to_goal'],
    transform: 'weight_goal',
    source: 'weight',
    hint: 'Everyone picks lose or gain and their own target; scored on % of it reached. Weights stay private.',
  }),
  fast_hours: def('fast_hours', {
    label: 'Hours fasted',
    unit: 'h',
    aggregate: 'sum',
    decimals: 1,
    icon: 'hourglass',
    group: 'fasting',
    hint: 'Finished fasts from SparkyFitness’ fasting tracker, counted on the day they end',
  }),
  fasts_completed: def('fasts_completed', {
    label: 'Fasts completed',
    unit: '',
    aggregate: 'sum',
    icon: 'hourglass',
    group: 'fasting',
    hint: 'Fasts that reached their target length',
  }),
};

export function isBuiltinMetric(key: string): key is BuiltinMetricKey {
  return (BUILTIN_METRICS as readonly string[]).includes(key);
}

export function isCustomMetric(key: string): key is CustomMetricKey {
  return key.startsWith('custom:') && key.length > 'custom:'.length;
}

/** The exercise name a lift metric is about, or null. */
export function liftExercise(key: string): { prefix: LiftPrefix; exercise: string } | null {
  for (const prefix of LIFT_PREFIXES) {
    if (key.startsWith(prefix)) {
      const exercise = key.slice(prefix.length);
      if (exercise.length >= 1 && exercise.length <= 60 && exercise === exercise.toLowerCase())
        return { prefix, exercise };
    }
  }
  return null;
}

export function isLiftMetric(key: string): key is LiftMetricKey {
  return liftExercise(key) != null;
}

export function isMetricKey(key: string): key is MetricKey {
  return isBuiltinMetric(key) || isCustomMetric(key) || isLiftMetric(key);
}

export interface CustomMetricOptions {
  label: string;
  unit?: string;
  aggregate: MetricAggregate;
  lowerIsBetter: boolean;
}

const titleCase = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/** Resolve a metric definition. Custom metrics carry their options on the challenge. */
export function metricDef(key: MetricKey, custom?: CustomMetricOptions): MetricDef {
  if (isBuiltinMetric(key)) return METRICS[key];
  const lift = liftExercise(key);
  if (lift?.prefix === 'lift_max:') {
    return {
      key,
      label: `${titleCase(lift.exercise)} max`,
      unit: 'kg',
      aggregate: 'avg',
      lowerIsBetter: false,
      decimals: 1,
      icon: 'dumbbell',
      group: 'strength',
      scoring: ['best_day'],
      hint: 'Heaviest set of this exercise in a day',
    };
  }
  if (lift?.prefix === 'lift_e1rm:') {
    return {
      key,
      label: `${titleCase(lift.exercise)} 1RM gain`,
      unit: '%',
      aggregate: 'last',
      lowerIsBetter: false,
      decimals: 1,
      icon: 'dumbbell',
      group: 'strength',
      scoring: ['best_day', 'total'],
      transform: 'relative',
      hint: 'Estimated one-rep max (Epley) vs your own starting point, so everyone competes on improvement',
    };
  }
  return {
    key,
    label: custom?.label ?? key.slice('custom:'.length),
    unit: custom?.unit ?? '',
    aggregate: custom?.aggregate ?? 'sum',
    lowerIsBetter: custom?.lowerIsBetter ?? false,
    decimals: 1,
    icon: 'plus',
    group: 'custom',
    scoring: (custom?.aggregate ?? 'sum') === 'sum' ? ALL_MODES : AVG_MODES,
  };
}

// ---------- Per-person scoring helpers ----------

/**
 * Closeness to a goal: 100 on target, 2 points off per 1% over or under, never below 0.
 * Null when there's no goal to measure against.
 */
export function adherenceScore(actual: number, goal: number | null | undefined): number | null {
  if (!goal || goal <= 0) return null;
  const offPct = (Math.abs(actual - goal) / goal) * 100;
  return Math.max(0, Math.round((100 - 2 * offPct) * 10) / 10);
}

/** Estimated one-rep max (Epley). Singles count as they are. */
export function epley1rm(weight: number, reps: number): number {
  if (weight <= 0 || reps <= 0) return 0;
  return reps === 1 ? weight : weight * (1 + reps / 30);
}

export interface WeightGoalParams {
  direction: 'lose' | 'gain';
  /** "percent" of starting weight, or "kg". */
  targetType: 'percent' | 'kg';
  target: number;
}

/**
 * % of a weight target reached on each day with a weigh-in. Starts from the last weigh-in on or
 * before the challenge's first day (or the first one in it). Capped at 100; can go negative when
 * moving the wrong way (floored at -100).
 */
export function weightGoalSeries(
  rows: { date: string; value: number }[],
  params: WeightGoalParams,
  startDate: string,
): { date: string; value: number }[] {
  const sorted = [...rows].filter((r) => r.value > 0).sort((a, b) => a.date.localeCompare(b.date));
  const before = sorted.filter((r) => r.date <= startDate);
  const baseline = (before.at(-1) ?? sorted[0])?.value;
  if (!baseline) return [];
  const targetKg = params.targetType === 'kg' ? params.target : (baseline * params.target) / 100;
  if (!(targetKg > 0)) return [];
  const sign = params.direction === 'lose' ? 1 : -1;
  return sorted
    .filter((r) => r.date >= startDate)
    .map((r) => ({
      date: r.date,
      // "+ 0" turns -0 into 0.
      value: Math.max(-100, Math.min(100, ((sign * (baseline - r.value)) / targetKg) * 100)) + 0,
    }));
}

/** % change from the last value on or before the start (or the first one after it). */
export function relativeSeries(
  rows: { date: string; value: number }[],
  startDate: string,
): { date: string; value: number }[] {
  const sorted = [...rows].filter((r) => r.value > 0).sort((a, b) => a.date.localeCompare(b.date));
  const before = sorted.filter((r) => r.date < startDate);
  const base = (before.at(-1) ?? sorted.find((r) => r.date >= startDate))?.value;
  if (!base) return [];
  return sorted
    .filter((r) => r.date >= startDate)
    .map((r) => ({ date: r.date, value: Math.round((r.value / base - 1) * 1000) / 10 }));
}

/**
 * A metric value as text, in the viewer's units and number format (metric and en-US by default).
 * km, kg and L become mi, lb and fl oz for people who chose imperial.
 */
export function formatMetricValue(
  value: number | null | undefined,
  def: Pick<MetricDef, 'decimals' | 'unit'>,
  withUnit = true,
  prefs: Pick<DisplayPrefs, 'units' | 'locale'> = DEFAULT_DISPLAY,
): string {
  return formatQuantity(value, def.unit, def.decimals, prefs, withUnit);
}

/** True when everyone joining must pick their own settings first (a weight target). */
export function needsWeightGoal(key: MetricKey): boolean {
  return isMetricKey(key) && metricDef(key).transform === 'weight_goal';
}

/**
 * Which kinds of events explain a metric's score. Workouts, lift sessions and fasts are read from
 * SparkyFitness; "day" is the day's total as Gauntlet stored it. Weight is never listed.
 */
export function eventKindsFor(key: string): ('workout' | 'lift' | 'fast' | 'day')[] {
  if (key === 'weight_goal') return [];
  if (key === 'workouts') return ['workout'];
  if (key === 'active_minutes' || key === 'active_calories' || key === 'distance')
    return ['workout', 'day'];
  if (key === 'lift_volume' || key === 'lift_sets' || isLiftMetric(key)) return ['lift'];
  if (key === 'fast_hours' || key === 'fasts_completed') return ['fast'];
  return ['day'];
}
