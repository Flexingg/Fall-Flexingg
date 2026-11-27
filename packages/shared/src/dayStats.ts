/**
 * Everything behind the configurable Today rings and the "day stats" screen, as pure functions so
 * the API (rows from its database) and the Android app's direct mode (rows merged on the phone)
 * agree: ring labels and goal presets, turning a ring config into today's rings, converting a goal
 * to and from what the person types (km/mi, L/fl oz), and one day's stats grouped into sections.
 */
import { addDays } from './dates.js';
import type { MetricRow } from './derive.js';
import { trendDef } from './derive.js';
import {
  DEFAULT_DISPLAY,
  formatQuantity,
  formatQuantityFlexible,
  fromDisplayUnit,
  toDisplayUnit,
  type DisplayPrefs,
  type UnitSystem,
} from './format.js';
import { METRICS } from './metrics.js';
import { DEFAULT_RINGS, type RingConfig, type RingMetric, type TodayRing } from './rings.js';

/** Plain labels for the ring picker and the Today legend. */
export const RING_LABELS: Record<RingMetric, string> = {
  steps: 'Steps',
  active_calories: 'Active kcal',
  active_minutes: 'Active min',
  distance: 'Distance',
  workouts: 'Workouts',
  sleep: 'Sleep',
  water: 'Water',
  protein: 'Protein',
  calories_in: 'Calories eaten',
  lift_sets: 'Sets lifted',
  lift_volume: 'Weight lifted',
  fast_hours: 'Hours fasted',
};

/** One short line under each stat in the picker. */
export const RING_HINTS: Record<RingMetric, string> = {
  steps: 'Steps walked today',
  active_calories: 'Calories burned moving',
  active_minutes: 'Minutes of activity',
  distance: 'How far you went',
  workouts: 'Workouts finished',
  sleep: "Last night's sleep",
  water: 'Water you drank',
  protein: 'Grams of protein eaten',
  calories_in: 'Calories you ate',
  lift_sets: 'Working sets lifted',
  lift_volume: 'Total weight lifted',
  fast_hours: 'Hours in a fast',
};

/**
 * Goal choices per stat, as the person sees them (their units). Imperial lists exist only where
 * the stored unit changes (distance, water, weight lifted) so the chips read as round numbers.
 */
const PRESETS: Record<RingMetric, { metric: number[]; imperial?: number[] }> = {
  steps: { metric: [5000, 7500, 10000, 12000, 15000] },
  active_calories: { metric: [300, 400, 500, 700, 1000] },
  active_minutes: { metric: [20, 30, 45, 60, 90] },
  distance: { metric: [3, 5, 8, 10, 15], imperial: [2, 3, 5, 6, 10] },
  workouts: { metric: [1, 2, 3] },
  sleep: { metric: [6, 7, 8, 9] },
  water: { metric: [1.5, 2, 2.5, 3, 4], imperial: [48, 64, 80, 100, 128] },
  protein: { metric: [80, 120, 150, 180, 220] },
  calories_in: { metric: [1500, 1800, 2200, 2500, 3000] },
  lift_sets: { metric: [10, 15, 20, 30] },
  lift_volume: { metric: [5000, 8000, 10000, 15000], imperial: [10000, 15000, 20000, 30000] },
  fast_hours: { metric: [12, 14, 16, 18, 20] },
};

/** The goal a stat starts with when picked for a ring (stored unit). */
const DEFAULT_GOALS: Record<RingMetric, number> = {
  steps: 10_000,
  active_calories: 500,
  active_minutes: 30,
  distance: 5,
  workouts: 1,
  sleep: 8,
  water: 2.5,
  protein: 150,
  calories_in: 2200,
  lift_sets: 20,
  lift_volume: 10_000,
  fast_hours: 16,
};

export const defaultGoal = (metric: RingMetric): number => DEFAULT_GOALS[metric];

/** Goal choices in the person's units (what they see and type). */
export function goalPresets(metric: RingMetric, units: UnitSystem): number[] {
  const p = PRESETS[metric];
  return units === 'imperial' && p.imperial ? p.imperial : p.metric;
}

/** How many decimals a goal in this unit is typed with. */
function goalDecimals(metric: RingMetric, units: UnitSystem): number {
  const q = toDisplayUnit(1, METRICS[metric].unit, METRICS[metric].decimals, units);
  return Math.min(q.decimals, 1);
}

/** A stored goal as the number the person sees and edits: 10 km -> 6.2 (mi), 2.5 L -> 85 (fl oz). */
export function goalToInput(metric: RingMetric, goal: number, units: UnitSystem): number {
  const q = toDisplayUnit(goal, METRICS[metric].unit, METRICS[metric].decimals, units);
  const f = 10 ** goalDecimals(metric, units);
  return Math.round(q.value * f) / f;
}

/** What the person typed (their units) back to the stored unit. */
export function goalFromInput(metric: RingMetric, typed: number, units: UnitSystem): number {
  return fromDisplayUnit(typed, METRICS[metric].unit, units);
}

/** The unit name shown beside the goal box ("mi", "fl oz", "steps", "hours"). */
export function goalUnitLabel(metric: RingMetric, units: UnitSystem): string {
  const q = toDisplayUnit(1, METRICS[metric].unit, METRICS[metric].decimals, units);
  if (metric === 'steps') return 'steps';
  if (q.unit === 'h') return 'hours';
  if (q.unit === 'min') return 'minutes';
  if (q.unit === 'kcal') return 'kcal';
  if (!q.unit) return metric === 'workouts' ? 'workouts' : metric === 'lift_sets' ? 'sets' : '';
  return q.unit;
}

/** Today's three rings from a config and a lookup of the day's stored values. */
export function buildRings(
  config: RingConfig,
  valueOf: (metric: RingMetric) => number | null,
): TodayRing[] {
  return config.map((s) => ({
    metric: s.metric,
    label: RING_LABELS[s.metric],
    unit: METRICS[s.metric].unit,
    value: valueOf(s.metric),
    goal: s.goal,
  }));
}

/** Same, reading one date out of daily rows. */
export function buildRingsFromRows(
  config: RingConfig,
  rows: MetricRow[],
  date: string,
): TodayRing[] {
  return buildRings(
    config,
    (m) => rows.find((r) => r.date === date && r.metric === m)?.value ?? null,
  );
}

/** The rings Today shows: the server's, or (older servers) the default three read from `metrics`. */
export function ringsOfToday(today: {
  rings?: TodayRing[];
  metrics: { key: string; value: number | null }[];
}): TodayRing[] {
  if (today.rings?.length === 3) return today.rings;
  return buildRings(DEFAULT_RINGS, (m) => today.metrics.find((x) => x.key === m)?.value ?? null);
}

/** Counts and calories carry their unit in the label ("Active kcal"), so the number alone reads fine. */
export const ringShowsUnit = (unit: string): boolean => !['', 'kcal', 'min'].includes(unit);

/** 0..1+ for the ring drawing. */
export const ringFraction = (r: Pick<TodayRing, 'value' | 'goal'>): number =>
  r.value != null && r.goal > 0 ? r.value / r.goal : 0;

/** "6.2 mi" or "6,200": a ring's value in the person's units. */
export function formatRingValue(
  r: Pick<TodayRing, 'metric' | 'value' | 'unit'>,
  prefs: Pick<DisplayPrefs, 'units' | 'locale'> = DEFAULT_DISPLAY,
  withUnit = true,
): string {
  return formatQuantity(r.value, r.unit, METRICS[r.metric].decimals, prefs, withUnit);
}

/** The goal as text in the person's units: "10,000" or "6.2 mi". */
export function formatRingGoal(
  r: Pick<TodayRing, 'metric' | 'goal' | 'unit'>,
  prefs: Pick<DisplayPrefs, 'units' | 'locale'> = DEFAULT_DISPLAY,
  withUnit = true,
): string {
  const q = toDisplayUnit(r.goal, r.unit, METRICS[r.metric].decimals, prefs.units);
  const f = 10 ** goalDecimals(r.metric, prefs.units);
  const text = formatQuantityFlexible(
    Math.round(q.value * f) / f,
    q.unit,
    goalDecimals(r.metric, prefs.units),
    { ...prefs, units: 'metric' },
  );
  return withUnit ? text : text.replace(/ \S+$/, '');
}

// ---------- One day's stats ----------

export interface DayStat {
  key: string;
  label: string;
  /** Stored unit (km, kg, L, ...); the app converts for display. */
  unit: string;
  decimals: number;
  value: number;
  /** The person's own goal for it, when there is one. */
  goal: number | null;
}

export interface DaySection {
  key: string;
  label: string;
  stats: DayStat[];
}

export interface DayResponse {
  date: string;
  isToday: boolean;
  rings: TodayRing[];
  sections: DaySection[];
}

/** How far back the day screen lets you page. */
export const DAY_HISTORY_DAYS = 90;

const SECTION_METRICS: { key: string; label: string; metrics: string[] }[] = [
  {
    key: 'activity',
    label: 'Activity',
    metrics: ['steps', 'distance', 'active_minutes', 'active_calories', 'workouts'],
  },
  { key: 'sleep', label: 'Sleep and heart', metrics: ['sleep', 'resting_hr'] },
  {
    key: 'nutrition',
    label: 'Food and water',
    metrics: ['calories_in', 'protein', 'carbs', 'fat', 'water'],
  },
  { key: 'strength', label: 'Strength', metrics: ['lift_sets', 'lift_volume'] },
  { key: 'fasting', label: 'Fasting', metrics: ['fast_hours', 'fasts_completed'] },
  { key: 'body', label: 'Body', metrics: ['weight'] },
];

/** Where a person's own food goals live (stored per day next to the stats). */
const GOAL_METRIC: Record<string, string> = {
  calories_in: 'goal_calories',
  protein: 'goal_protein',
  carbs: 'goal_carbs',
  fat: 'goal_fat',
  water: 'goal_water',
};

/**
 * Every stat the person has for one day, in sections (activity, sleep and heart, food and water,
 * strength, fasting, body, then custom measurements), each against their own goal where one exists.
 * `rows` must be the person's own: weight and the rest are only ever shown to their owner.
 */
export function buildDay(opts: {
  rows: MetricRow[];
  date: string;
  today: string;
  config: RingConfig;
}): DayResponse {
  const { rows, date, today, config } = opts;
  const byMetric = new Map(rows.filter((r) => r.date === date).map((r) => [r.metric, r.value]));
  const ringGoal = new Map<string, number>(config.map((s) => [s.metric, s.goal]));
  const stat = (key: string): DayStat | null => {
    const value = byMetric.get(key);
    const d = trendDef(key);
    if (value == null || !d) return null;
    const own = GOAL_METRIC[key] ? byMetric.get(GOAL_METRIC[key]!) : undefined;
    return {
      key,
      label: key in RING_LABELS ? RING_LABELS[key as RingMetric] : d.label,
      unit: d.unit,
      decimals: d.decimals,
      value,
      goal: ringGoal.get(key) ?? (own != null && own > 0 ? own : null),
    };
  };
  const sections: DaySection[] = SECTION_METRICS.map((s) => ({
    key: s.key,
    label: s.label,
    stats: s.metrics.map(stat).filter((x): x is DayStat => x != null),
  }));
  const lifts = [...byMetric.keys()]
    .filter((k) => k.startsWith('lift_max:'))
    .sort()
    .map(stat)
    .filter((x): x is DayStat => x != null);
  sections.find((s) => s.key === 'strength')!.stats.push(...lifts);
  sections.push({
    key: 'custom',
    label: 'Other measurements',
    stats: [...byMetric.keys()]
      .filter((k) => k.startsWith('custom:'))
      .sort()
      .map(stat)
      .filter((x): x is DayStat => x != null),
  });
  return {
    date,
    isToday: date === today,
    rings: buildRingsFromRows(config, rows, date),
    sections: sections.filter((s) => s.stats.length > 0),
  };
}

/** The earliest day the day screen can show. */
export const earliestDay = (today: string): string => addDays(today, -DAY_HISTORY_DAYS);
