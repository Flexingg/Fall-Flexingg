/**
 * The three Today rings, which a person can set up: which stat each ring shows and the daily goal
 * that fills it. Saved per person on the server (users.ring_config) and, in direct mode, on the
 * phone. The Today card, the day screen and the Android home-screen widget / watch tile all draw
 * from the same config, so changing a ring changes it everywhere.
 */
import { z } from 'zod';
import type { BuiltinMetricKey } from './metrics.js';

/** Stats a ring can show: daily totals where "more is better" and a goal makes sense. */
export const RING_METRICS = [
  'steps',
  'active_calories',
  'active_minutes',
  'distance',
  'workouts',
  'sleep',
  'water',
  'protein',
  'calories_in',
  'lift_sets',
  'lift_volume',
  'fast_hours',
] as const satisfies readonly BuiltinMetricKey[];
export type RingMetric = (typeof RING_METRICS)[number];

export interface RingSlot {
  metric: RingMetric;
  /** Daily goal in the metric's stored unit (km for distance, hours for sleep, litres for water). */
  goal: number;
}

/** Outer, middle, inner. */
export type RingConfig = [RingSlot, RingSlot, RingSlot];

export const DEFAULT_RINGS: RingConfig = [
  { metric: 'steps', goal: 10_000 },
  { metric: 'active_calories', goal: 500 },
  { metric: 'active_minutes', goal: 30 },
];

const slot = z.object({
  metric: z.enum(RING_METRICS),
  goal: z.number().positive().max(1_000_000),
});

/** Three rings, each a different stat. */
export const ringConfigSchema = z
  .tuple([slot, slot, slot])
  .refine((r) => new Set(r.map((s) => s.metric)).size === 3, 'Each ring needs a different stat');

/** A saved config, or the defaults when there is none (or it no longer validates). */
export function ringsOf(saved: unknown): RingConfig {
  const r = ringConfigSchema.safeParse(saved);
  return r.success ? (r.data as RingConfig) : DEFAULT_RINGS;
}

/** One ring as Today shows it. */
export interface TodayRing {
  metric: RingMetric;
  label: string;
  unit: string;
  value: number | null;
  goal: number;
}
