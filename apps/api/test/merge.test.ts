import { describe, expect, it } from 'vitest';
import { mergeDaily, type MergeInput } from '../src/sparky/merge.js';

const empty: MergeInput = {
  start: '2026-10-01',
  end: '2026-10-03',
  daily: [],
  checkIns: [],
  custom: {},
  exerciseDays: [],
  exerciseEntries: [],
  sleep: [],
  customMetrics: {},
};

const pick = (rows: ReturnType<typeof mergeDaily>, date: string, metric: string) =>
  rows.find((r) => r.date === date && r.metric === metric);

describe('mergeDaily', () => {
  it('takes the highest source for steps instead of adding watch and phone', () => {
    const rows = mergeDaily({
      ...empty,
      daily: [{ entry_date: '2026-10-01', source_provider: 'garmin', total_steps: 9000 }],
      checkIns: [
        { entry_date: '2026-10-01', steps: 8500, updated_at: '2026-10-01T20:00:00Z' },
        { entry_date: '2026-10-02', steps: '4000', updated_at: '2026-10-02T08:00:00Z' },
        { entry_date: '2026-10-02', steps: 7000, updated_at: '2026-10-02T20:00:00Z' },
      ],
    });
    expect(pick(rows, '2026-10-01', 'steps')).toMatchObject({ value: 9000, source: 'garmin' });
    expect(pick(rows, '2026-10-02', 'steps')).toMatchObject({ value: 7000, source: 'check-in' });
  });

  it('reads distance from wearables, the phone-sync category, or workouts', () => {
    const rows = mergeDaily({
      ...empty,
      daily: [{ entry_date: '2026-10-01', source_provider: 'garmin', total_distance_meters: 6200 }],
      custom: {
        distance: {
          category: { id: 'c1', name: 'distance', frequency: 'Daily' },
          rows: [{ date: '2026-10-02', value: '5100', timestamp: '2026-10-02T23:00:00Z' }],
        },
      },
      exerciseDays: [
        {
          startDate: '2026-10-03',
          distanceMeters: 10200,
          durationMinutes: 55,
          caloriesBurned: 640,
          workoutCount: 1,
        },
      ],
    });
    expect(pick(rows, '2026-10-01', 'distance')!.value).toBe(6.2);
    expect(pick(rows, '2026-10-02', 'distance')!.value).toBe(5.1);
    expect(pick(rows, '2026-10-03', 'distance')!.value).toBe(10.2);
    expect(pick(rows, '2026-10-03', 'workouts')!.value).toBe(1);
    expect(pick(rows, '2026-10-03', 'active_minutes')!.value).toBe(55);
  });

  it('uses phone "Active Calories" entries and ignores other entries for that metric', () => {
    const rows = mergeDaily({
      ...empty,
      exerciseEntries: [
        { entry_date: '2026-10-01', exercise_name: 'Active Calories', calories_burned: '612' },
        { entry_date: '2026-10-01', exercise_name: 'Running', calories_burned: 300 },
      ],
    });
    expect(pick(rows, '2026-10-01', 'active_calories')!.value).toBe(612);
  });

  it('prefers wearable resting HR over measurements', () => {
    const rows = mergeDaily({
      ...empty,
      daily: [{ entry_date: '2026-10-01', source_provider: 'garmin', resting_heart_rate: 52 }],
      custom: {
        resting_heart_rate: {
          category: { id: 'c2', name: 'resting_heart_rate', frequency: 'All' },
          rows: [
            { date: '2026-10-01', value: 60 },
            { date: '2026-10-02', value: 58 },
            { date: '2026-10-02', value: 56 },
          ],
        },
      },
    });
    expect(pick(rows, '2026-10-01', 'resting_hr')!.value).toBe(52);
    expect(pick(rows, '2026-10-02', 'resting_hr')!.value).toBe(57);
    expect(rows.filter((r) => r.metric === 'resting_hr')).toHaveLength(2);
  });

  it('sums sleep per source and keeps the biggest source', () => {
    const rows = mergeDaily({
      ...empty,
      sleep: [
        { entry_date: '2026-10-02', time_asleep_in_seconds: 6 * 3600, source: 'garmin' },
        { entry_date: '2026-10-02', duration_in_seconds: 3600, source: 'garmin' },
        { entry_date: '2026-10-02', time_asleep_in_seconds: 6.5 * 3600, source: 'Health Connect' },
      ],
    });
    expect(pick(rows, '2026-10-02', 'sleep')).toMatchObject({ value: 7, source: 'garmin' });
  });

  it('produces custom metrics with the challenge aggregate and drops out-of-range dates', () => {
    const rows = mergeDaily({
      ...empty,
      customMetrics: { pushups: 'sum' },
      custom: {
        pushups: {
          category: { id: 'c3', name: 'Pushups', frequency: 'All' },
          rows: [
            { date: '2026-10-01', value: 20 },
            { date: '2026-10-01', value: 30 },
            { date: '2026-09-30', value: 99 },
          ],
        },
      },
    });
    expect(pick(rows, '2026-10-01', 'custom:pushups')!.value).toBe(50);
    expect(rows.some((r) => r.date === '2026-09-30')).toBe(false);
  });
});
