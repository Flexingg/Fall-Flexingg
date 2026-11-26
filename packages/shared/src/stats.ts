/**
 * Types for the Stats screens: head-to-head on a profile and the workout detail view. Pure shapes
 * (plus the metric list head-to-head compares), shared by the API and the web app.
 */
import { z } from 'zod';

/** What head-to-head puts side by side: only totals that mean something to compare. Never body,
 *  food or sleep numbers. */
export const COMPARE_METRICS = [
  'steps',
  'distance',
  'active_minutes',
  'workouts',
  'lift_volume',
] as const;

export const compareQuerySchema = z.object({
  range: z.enum(['day', 'week', 'month']).default('week'),
});

export interface CompareMetric {
  key: string;
  label: string;
  unit: string;
  me: number;
  /** Null when they keep their stats private (then `metrics` is empty anyway). */
  them: number | null;
}

export interface CompareResponse {
  range: 'day' | 'week' | 'month';
  metrics: CompareMetric[];
  /** Finished challenges you were both in with a score: who finished higher. */
  record: { me: number; them: number; shared: number };
  /** They don't share profile stats: only the challenge record is shown. */
  theirsHidden: boolean;
  /** Their display name, for "You 3 – 2 Maya". */
  theirName: string;
}

export type WorkoutKind = 'cardio' | 'strength';

export interface WorkoutSummary {
  /** `YYYY-MM-DD.key`: the day plus which entry (or strength session) on it. */
  id: string;
  date: string;
  /** Start time when SparkyFitness has one (ISO). */
  startedAt: string | null;
  /** Local time of day it started ("07:37"), when only that is known. */
  startTime?: string | null;
  name: string;
  kind: WorkoutKind;
  /** "Garmin", "Hevy", "Liftosaur"…, or null when unknown. */
  source: string | null;
  minutes: number | null;
  kcal: number | null;
  distanceKm: number | null;
  /** Strength only: total of reps × kg over the working sets. */
  volumeKg: number | null;
  /** "40 min · 450 kcal": one line for lists. */
  summary: string;
}

export interface WorkoutSet {
  n: number;
  reps: number;
  kg: number;
  warmup: boolean;
  /** Estimated one-rep max for this set (working sets with weight only). */
  e1rm: number | null;
}

export interface WorkoutExercise {
  name: string;
  sets: WorkoutSet[];
  volumeKg: number;
  bestE1rm: number | null;
}

export interface WorkoutDetail extends WorkoutSummary {
  avgHeartRate: number | null;
  exercises: WorkoutExercise[];
  owner: { id: string; displayName: string; isMe: boolean };
}

export interface WorkoutsResponse {
  workouts: WorkoutSummary[];
}

export const workoutsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

export const workoutDetailQuerySchema = z.object({
  /** Whose workout, when not yours. */
  userId: z.string().uuid().optional(),
});
