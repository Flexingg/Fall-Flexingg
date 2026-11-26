import { describe, expect, it } from 'vitest';
import { buildWorkouts } from '../src/workouts.js';

describe('start time from SparkyFitness', () => {
  it("uses entry_time (local wall clock) when there's no ISO start", () => {
    const list = buildWorkouts(
      [
        {
          entry_date: '2026-11-20',
          exercise_name: 'walking',
          duration_minutes: 65,
          distance: 3.9,
          entry_time: '07:37:00',
        },
      ],
      { start: '2026-11-01', end: '2026-11-30' },
    );
    expect(list[0]).toMatchObject({ startedAt: null, startTime: '07:37' });
  });
});
