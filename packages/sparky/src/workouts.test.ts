import { describe, expect, it } from 'vitest';
import type { ExerciseEntryRow } from './client.js';
import { buildEvents } from './merge.js';
import { buildWorkouts } from './workouts.js';

const run = (extra: Partial<ExerciseEntryRow> = {}): ExerciseEntryRow => ({
  entry_date: '2026-10-01',
  exercise_name: 'Running',
  duration_minutes: 40,
  calories_burned: 450,
  exercise_source: 'garmin',
  ...extra,
});

describe('buildWorkouts', () => {
  it('drops day totals, stuck sessions and the same session written twice', () => {
    const list = buildWorkouts([
      run(),
      run({ exercise_name: 'Run', exercise_source: 'strava', duration_minutes: 41 }),
      { entry_date: '2026-10-01', exercise_name: 'Active Calories', calories_burned: 800 },
      run({ exercise_name: 'Walk', duration_minutes: 900, calories_burned: 10 }),
    ]);
    expect(list.map((w) => w.name)).toEqual(['Running']);
  });

  it('keys a workout by its SparkyFitness id, else its place on the day', () => {
    const list = buildWorkouts([
      run({ id: 'a/b c' }),
      run({ exercise_name: 'Cycling', duration_minutes: 90, calories_burned: 700 }),
    ]);
    expect(list.map((w) => w.id).sort()).toEqual(['2026-10-01.abc', '2026-10-01.n1']);
  });

  it('groups one app’s lifts on a day into a session, warm-ups kept out of the totals', () => {
    const [w] = buildWorkouts([
      {
        entry_date: '2026-10-02',
        exercise_name: 'squat',
        exercise_source: 'hevy',
        sets: [
          { set_type: 'Warm-up', reps: 5, weight: 40 },
          { set_type: 'Working Set', reps: 1, weight: 150 },
        ],
      },
      {
        entry_date: '2026-10-02',
        exercise_name: 'Deadlift',
        exercise_source: 'hevy',
        sets: [{ reps: 3, weight: 180 }],
      },
    ]);
    expect(w).toMatchObject({ id: '2026-10-02.s-hevy', kind: 'strength', volumeKg: 150 + 540 });
    expect(w!.exercises[0]).toMatchObject({ name: 'Squat', bestE1rm: 150, volumeKg: 150 });
    expect(w!.exercises[0]!.sets[0]).toMatchObject({ warmup: true, e1rm: null });
  });

  it('gives events the id that opens the same workout', () => {
    const entries = [
      run({ id: 'r1' }),
      {
        entry_date: '2026-10-01',
        exercise_name: 'Squat',
        exercise_source: 'hevy',
        sets: [{ reps: 5, weight: 100 }],
      },
    ];
    const ids = new Set(buildWorkouts(entries).map((w) => w.id));
    const events = buildEvents({ start: '2026-10-01', end: '2026-10-01', exerciseEntries: entries });
    expect(events.length).toBe(2);
    for (const { event } of events) expect(ids.has(event.workoutId!)).toBe(true);
  });
});
