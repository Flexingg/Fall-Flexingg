/**
 * The metrics a challenge can be scored on. Raw values come from SparkyFitness;
 * the API normalises every source into one value per user, day and metric.
 */

export const BUILTIN_METRICS = [
  'steps',
  'distance',
  'active_minutes',
  'active_calories',
  'workouts',
  'sleep',
  'resting_hr',
] as const;

export type BuiltinMetricKey = (typeof BUILTIN_METRICS)[number];
export type CustomMetricKey = `custom:${string}`;
export type MetricKey = BuiltinMetricKey | CustomMetricKey;

/** How a metric's daily values combine over a period. */
export type MetricAggregate = 'sum' | 'avg';

export interface MetricDef {
  key: MetricKey;
  label: string;
  /** Unit shown after values, e.g. "km". Empty for plain counts. */
  unit: string;
  aggregate: MetricAggregate;
  lowerIsBetter: boolean;
  decimals: number;
  icon: MetricIcon;
}

export type MetricIcon =
  'steps' | 'distance' | 'timer' | 'flame' | 'dumbbell' | 'moon' | 'pulse' | 'plus';

export const METRICS: Record<BuiltinMetricKey, MetricDef> = {
  steps: {
    key: 'steps',
    label: 'Steps',
    unit: '',
    aggregate: 'sum',
    lowerIsBetter: false,
    decimals: 0,
    icon: 'steps',
  },
  distance: {
    key: 'distance',
    label: 'Distance',
    unit: 'km',
    aggregate: 'sum',
    lowerIsBetter: false,
    decimals: 1,
    icon: 'distance',
  },
  active_minutes: {
    key: 'active_minutes',
    label: 'Active min',
    unit: 'min',
    aggregate: 'sum',
    lowerIsBetter: false,
    decimals: 0,
    icon: 'timer',
  },
  active_calories: {
    key: 'active_calories',
    label: 'Calories',
    unit: 'kcal',
    aggregate: 'sum',
    lowerIsBetter: false,
    decimals: 0,
    icon: 'flame',
  },
  workouts: {
    key: 'workouts',
    label: 'Workouts',
    unit: '',
    aggregate: 'sum',
    lowerIsBetter: false,
    decimals: 0,
    icon: 'dumbbell',
  },
  sleep: {
    key: 'sleep',
    label: 'Sleep',
    unit: 'h',
    aggregate: 'avg',
    lowerIsBetter: false,
    decimals: 1,
    icon: 'moon',
  },
  resting_hr: {
    key: 'resting_hr',
    label: 'Resting HR',
    unit: 'bpm',
    aggregate: 'avg',
    lowerIsBetter: true,
    decimals: 0,
    icon: 'pulse',
  },
};

export function isBuiltinMetric(key: string): key is BuiltinMetricKey {
  return (BUILTIN_METRICS as readonly string[]).includes(key);
}

export function isCustomMetric(key: string): key is CustomMetricKey {
  return key.startsWith('custom:') && key.length > 'custom:'.length;
}

export function isMetricKey(key: string): key is MetricKey {
  return isBuiltinMetric(key) || isCustomMetric(key);
}

export interface CustomMetricOptions {
  label: string;
  unit?: string;
  aggregate: MetricAggregate;
  lowerIsBetter: boolean;
}

/** Resolve a metric definition. Custom metrics carry their options on the challenge. */
export function metricDef(key: MetricKey, custom?: CustomMetricOptions): MetricDef {
  if (isBuiltinMetric(key)) return METRICS[key];
  return {
    key,
    label: custom?.label ?? key.slice('custom:'.length),
    unit: custom?.unit ?? '',
    aggregate: custom?.aggregate ?? 'sum',
    lowerIsBetter: custom?.lowerIsBetter ?? false,
    decimals: 1,
    icon: 'plus',
  };
}

export function formatMetricValue(
  value: number | null | undefined,
  def: Pick<MetricDef, 'decimals' | 'unit'>,
  withUnit = true,
): string {
  if (value == null || !Number.isFinite(value)) return '–';
  const text = value.toLocaleString('en-US', {
    minimumFractionDigits: def.decimals,
    maximumFractionDigits: def.decimals,
  });
  return withUnit && def.unit ? `${text} ${def.unit}` : text;
}

/** Compact form for tight spots: 12,400 -> 12.4k. */
export function formatCompact(value: number, decimals = 1): string {
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(decimals).replace(/\.0$/, '')}k`;
  return value.toLocaleString('en-US', { maximumFractionDigits: decimals });
}
