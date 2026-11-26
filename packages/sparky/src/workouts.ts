/**
 * Workouts as a list and as one detail view, built from SparkyFitness exercise entries when
 * someone looks (nothing is stored). Uses the same cleaning as the daily numbers (duplicates and
 * stuck sessions dropped), so the list matches what scored. Cardio is one entry per workout;
 * strength entries from one app on one day are one session, each entry an exercise in it.
 */
import {
  epley1rm,
  type WorkoutDetail,
  type WorkoutExercise,
  type WorkoutSet,
  type WorkoutSummary,
} from '@gauntlet/shared';
import type { ExerciseEntryRow, ExerciseSetRow } from './client.js';
import {
  ACTIVE_CALORIES_ENTRY,
  cleanWorkouts,
  entryKeys,
  hasWorkingSets,
  sourceLabel,
  strengthKey,
} from './merge.js';

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number.parseFloat(v) : (v as number | null | undefined);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const day = (v: string | null | undefined) =>
  v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
const titleCase = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
const nf = (n: number, digits = 0) =>
  n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const isWarmup = (s: ExerciseSetRow) => /warm/i.test(s.set_type ?? '');

/** A workout with its detail, before the API says whose it is. */
export type WorkoutFull = Omit<WorkoutDetail, 'owner'>;

/** "07:37:00" -> "07:37" (SparkyFitness' entry_time is a local wall-clock time, no zone). */
function wallTime(v: string | null | undefined): string | null {
  const m = /^(\d{2}):(\d{2})/.exec(v ?? '');
  return m ? `${m[1]}:${m[2]}` : null;
}

function isoOrNull(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function exerciseOf(e: ExerciseEntryRow): WorkoutExercise | null {
  const sets: WorkoutSet[] = [];
  let volume = 0;
  let best: number | null = null;
  (e.sets ?? []).forEach((s, i) => {
    const reps = num(s.reps) ?? 0;
    const kg = num(s.weight) ?? 0;
    if (reps <= 0) return;
    const warmup = isWarmup(s);
    const e1rm = !warmup && kg > 0 ? epley1rm(kg, reps) : null;
    if (!warmup) volume += kg * reps;
    if (e1rm != null && (best == null || e1rm > best)) best = e1rm;
    sets.push({ n: num(s.set_number) ?? i + 1, reps, kg, warmup, e1rm });
  });
  if (!sets.length) return null;
  return {
    name: titleCase((e.exercise_name ?? 'Exercise').trim()),
    sets,
    volumeKg: volume,
    bestE1rm: best,
  };
}

function line(parts: (string | null)[]): string {
  return parts.filter(Boolean).join(' · ');
}

/** Every workout in the entries, newest first, each with its detail. */
export function buildWorkouts(
  entries: ExerciseEntryRow[],
  opts: { start?: string; end?: string } = {},
): WorkoutFull[] {
  const keys = entryKeys(entries);
  const inWindow = (d: string) => (!opts.start || d >= opts.start) && (!opts.end || d <= opts.end);
  const out: WorkoutFull[] = [];

  // Cardio and other timed workouts (entries without sets), deduplicated like the daily numbers.
  for (const [date, list] of cleanWorkouts(entries)) {
    if (!inWindow(date)) continue;
    for (const w of list) {
      if (hasWorkingSets(w.entry)) continue;
      const km = num(w.entry.distance);
      const hr = num(w.entry.avg_heart_rate);
      const source = w.source ? sourceLabel(w.source) : null;
      out.push({
        id: `${date}.${keys.get(w.entry)}`,
        date,
        startedAt: isoOrNull(w.entry.start_time),
        startTime: wallTime(w.entry.entry_time),
        name: titleCase(w.name),
        kind: 'cardio',
        source,
        minutes: w.minutes,
        kcal: w.kcal > 0 ? w.kcal : null,
        distanceKm: km != null && km > 0 ? km : null,
        volumeKg: null,
        summary: line([
          `${nf(w.minutes)} min`,
          km != null && km > 0 ? `${nf(km, 1)} km` : null,
          w.kcal > 0 ? `${nf(w.kcal)} kcal` : null,
        ]),
        avgHeartRate: hr != null && hr > 0 ? Math.round(hr) : null,
        exercises: [],
      });
    }
  }

  // Strength: one session per app per day.
  const sessions = new Map<string, ExerciseEntryRow[]>();
  for (const e of entries) {
    const date = day(e.entry_date);
    if (!date || !inWindow(date) || !hasWorkingSets(e)) continue;
    if ((e.exercise_name ?? '').trim().toLowerCase() === ACTIVE_CALORIES_ENTRY) continue;
    const id = `${date}.${strengthKey(e)}`;
    sessions.set(id, [...(sessions.get(id) ?? []), e]);
  }
  for (const [id, list] of sessions) {
    const date = id.slice(0, 10);
    const exercises = list.map(exerciseOf).filter((x): x is WorkoutExercise => x != null);
    const volume = exercises.reduce((a, x) => a + x.volumeKg, 0);
    const working = exercises.reduce((a, x) => a + x.sets.filter((s) => !s.warmup).length, 0);
    const minutes = list.reduce((a, e) => a + (num(e.duration_minutes) ?? 0), 0);
    const kcal = list.reduce((a, e) => a + (num(e.calories_burned) ?? 0), 0);
    const hr = list.map((e) => num(e.avg_heart_rate)).find((v) => v != null && v > 0) ?? null;
    const first = list[0]!;
    const times = list.map((e) => isoOrNull(e.start_time)).filter((t): t is string => t != null);
    out.push({
      id,
      date,
      startedAt: times.sort()[0] ?? null,
      startTime:
        list
          .map((e) => wallTime(e.entry_time))
          .filter((t): t is string => t != null)
          .sort()[0] ?? null,
      name:
        exercises.length === 1
          ? exercises[0]!.name
          : `Strength workout · ${exercises.length} exercises`,
      kind: 'strength',
      source: first.exercise_source ? sourceLabel(first.exercise_source) : null,
      minutes: minutes > 0 ? minutes : null,
      kcal: kcal > 0 ? kcal : null,
      distanceKm: null,
      volumeKg: volume > 0 ? volume : null,
      summary: line([
        `${working} ${working === 1 ? 'set' : 'sets'}`,
        volume > 0 ? `${nf(volume)} kg volume` : null,
        minutes > 0 ? `${nf(minutes)} min` : null,
      ]),
      avgHeartRate: hr != null ? Math.round(hr) : null,
      exercises,
    });
  }

  return out.sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      (b.startedAt ?? '').localeCompare(a.startedAt ?? '') ||
      a.id.localeCompare(b.id),
  );
}

/** The list shape: everything but the per-exercise detail. */
export function toSummary(w: WorkoutFull): WorkoutSummary {
  const { avgHeartRate: _hr, exercises: _ex, ...summary } = w;
  return summary;
}
