/**
 * The Health Connect types Gauntlet reads back from SparkyFitness and shows on the day screen and
 * Trends (0.17). They are personal health data, not challenge metrics: they are never scored, never
 * offered as a challenge metric, and only ever shown to their owner (like weight).
 *
 * `categories` are the SparkyFitness custom measurement names the phone writes them under (see
 * apps/web/src/lib/healthRecords.ts); `fromSparky` marks the few SparkyFitness keeps in a dedicated
 * place instead (check-ins and the like), which the merge reads from there.
 */
export type HealthSection = 'activity' | 'heart' | 'body' | 'nutrition' | 'mind';

export interface HealthMetricDef {
  label: string;
  /** Stored unit (what the value is in). */
  unit: string;
  decimals: number;
  /** How several days roll up on Trends. */
  aggregate: 'sum' | 'avg' | 'max' | 'min' | 'last';
  section: HealthSection;
  /** SparkyFitness custom measurement category names (lower case) holding it, if any. */
  categories: string[];
  /** True when SparkyFitness stores it somewhere other than a custom measurement. */
  fromSparky?: boolean;
}

export const HEALTH_METRICS = {
  hr_avg: hm('Average heart rate', 'bpm', 0, 'avg', 'heart', ['heart_rate_avg']),
  hr_min: hm('Lowest heart rate', 'bpm', 0, 'min', 'heart', ['heart_rate_min']),
  hr_max: hm('Highest heart rate', 'bpm', 0, 'max', 'heart', ['heart_rate_max']),
  hrv: hm('Heart rate variability', 'ms', 0, 'avg', 'heart', ['hrv']),
  respiratory_rate: hm('Breathing rate', 'breaths/min', 1, 'avg', 'heart', ['respiratory_rate']),
  spo2: hm('Blood oxygen', '%', 0, 'avg', 'heart', ['oxygen_saturation']),
  vo2_max: hm('VO2 max', 'ml/kg/min', 1, 'last', 'heart', ['vo2_max']),
  bp_systolic: hm('Blood pressure (systolic)', 'mmHg', 0, 'avg', 'heart', [
    'blood_pressure_systolic',
  ]),
  bp_diastolic: hm('Blood pressure (diastolic)', 'mmHg', 0, 'avg', 'heart', [
    'blood_pressure_diastolic',
  ]),
  blood_glucose: hm('Blood sugar', 'mmol/L', 1, 'avg', 'heart', ['blood_glucose']),
  body_temp: hm('Body temperature', '°C', 1, 'avg', 'heart', ['body_temperature']),
  basal_body_temp: hm('Basal body temperature', '°C', 2, 'avg', 'heart', [
    'basal_body_temperature',
  ]),
  floors: hm('Floors climbed', '', 0, 'sum', 'activity', ['floors_climbed']),
  total_calories: hm('Total calories burned', 'kcal', 0, 'sum', 'activity', [], true),
  bmr: hm('Resting calories', 'kcal', 0, 'avg', 'body', [], true),
  body_fat: hm('Body fat', '%', 1, 'last', 'body', [], true),
  height: hm('Height', 'cm', 0, 'last', 'body', [], true),
  food_energy: hm('Food energy (Health Connect)', 'kcal', 0, 'sum', 'nutrition', [
    'dietary_energy',
  ]),
  mindful_minutes: hm('Mindfulness', 'min', 0, 'sum', 'mind', ['mindfulness_minutes']),
} as const satisfies Record<string, HealthMetricDef>;

export type HealthMetricKey = keyof typeof HEALTH_METRICS;
export const HEALTH_METRIC_KEYS = Object.keys(HEALTH_METRICS) as HealthMetricKey[];

export const isHealthMetric = (key: string): key is HealthMetricKey =>
  Object.prototype.hasOwnProperty.call(HEALTH_METRICS, key);

/** Every custom measurement category name a health metric is read from (lower case). */
export const HEALTH_CATEGORY_NAMES: string[] = HEALTH_METRIC_KEYS.flatMap((k) => [
  ...(HEALTH_METRICS[k] as HealthMetricDef).categories,
]);

/** The health metric a SparkyFitness custom category feeds, if any. */
export function healthMetricOfCategory(name: string): HealthMetricKey | null {
  const n = name.trim().toLowerCase();
  return (
    HEALTH_METRIC_KEYS.find((k) => (HEALTH_METRICS[k] as HealthMetricDef).categories.includes(n)) ??
    null
  );
}

function hm(
  label: string,
  unit: string,
  decimals: number,
  aggregate: HealthMetricDef['aggregate'],
  section: HealthSection,
  categories: string[],
  fromSparky = false,
): HealthMetricDef {
  return {
    label,
    unit,
    decimals,
    aggregate,
    section,
    categories,
    ...(fromSparky ? { fromSparky } : {}),
  };
}
