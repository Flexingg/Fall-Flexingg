/**
 * The stats the phone reports Health Connect origins for (see HcOrigin in statSource.ts). The phone
 * and the server share this list so the server can refuse a key nobody reads. Values are in each
 * stat's stored unit: distance km, water L, sleep hours asleep, workouts a count, the rest as in
 * metrics.ts / healthMetrics.ts.
 */
import { HEALTH_METRIC_KEYS } from './healthMetrics.js';

export const HC_ORIGIN_CORE_METRICS = [
  'steps',
  'distance',
  'active_calories',
  'resting_hr',
  'water',
  'weight',
  'sleep',
  'workouts',
] as const;

export const HC_ORIGIN_METRICS: readonly string[] = [
  ...HC_ORIGIN_CORE_METRICS,
  ...HEALTH_METRIC_KEYS,
];

export const isHcOriginMetric = (key: string): boolean => HC_ORIGIN_METRICS.includes(key);
