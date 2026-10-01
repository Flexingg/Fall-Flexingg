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
      exerciseEntries: [
        {
          entry_date: '2026-10-03',
          exercise_name: 'Running',
          duration_minutes: 55,
          calories_burned: 640,
        },
      ],
    });
    expect(pick(rows, '2026-10-01', 'distance')!.value).toBe(6.2);
    expect(pick(rows, '2026-10-02', 'distance')!.value).toBe(5.1);
    expect(pick(rows, '2026-10-03', 'distance')!.value).toBe(10.2);
    expect(pick(rows, '2026-10-03', 'workouts')!.value).toBe(1);
    expect(pick(rows, '2026-10-03', 'active_minutes')!.value).toBe(55);
  });

  // Shapes below are taken from a real SparkyFitness account synced from Health Connect.
  it('drops stuck sessions and duplicate workouts', () => {
    const rows = mergeDaily({
      ...empty,
      exerciseEntries: [
        {
          entry_date: '2026-10-01',
          exercise_name: 'Strength Training',
          duration_minutes: 51.2,
          calories_burned: 149.43,
        },
        {
          entry_date: '2026-10-01',
          exercise_name: 'Strength Training',
          duration_minutes: 1438,
          calories_burned: 1745.62,
        },
        {
          entry_date: '2026-10-01',
          exercise_name: 'Strength Training',
          duration_minutes: 51,
          calories_burned: 149.58,
        },
        {
          entry_date: '2026-10-01',
          exercise_name: 'Active Calories',
          duration_minutes: 0,
          calories_burned: 420,
        },
        {
          entry_date: '2026-10-02',
          exercise_name: 'Strength Training',
          duration_minutes: 0.4,
          calories_burned: 1,
        },
        {
          entry_date: '2026-10-02',
          exercise_name: 'Walking',
          duration_minutes: 16,
          calories_burned: 78.55,
        },
        {
          entry_date: '2026-10-02',
          exercise_name: 'Weightlifting',
          duration_minutes: 35,
          calories_burned: 210,
        },
        {
          entry_date: '2026-10-02',
          exercise_name: 'Strength Training',
          duration_minutes: 36,
          calories_burned: 210,
        },
      ],
    });
    expect(pick(rows, '2026-10-01', 'workouts')!.value).toBe(1);
    expect(pick(rows, '2026-10-01', 'active_minutes')!.value).toBe(51.2);
    // Walking + Weightlifting; "Strength Training 36 min / 210 kcal" is the same session as Weightlifting.
    expect(pick(rows, '2026-10-02', 'workouts')!.value).toBe(2);
  });

  it('prefers the whole-day active calories over adding up workouts', () => {
    const rows = mergeDaily({
      ...empty,
      exerciseEntries: [
        { entry_date: '2026-10-01', exercise_name: 'Active Calories', calories_burned: 420 },
        {
          entry_date: '2026-10-01',
          exercise_name: 'Strength Training',
          duration_minutes: 75,
          calories_burned: 500,
        },
        {
          entry_date: '2026-10-02',
          exercise_name: 'Running',
          duration_minutes: 30,
          calories_burned: 300,
        },
      ],
      daily: [{ entry_date: '2026-10-03', source_provider: 'garmin', active_calories: 610 }],
    });
    expect(pick(rows, '2026-10-01', 'active_calories')).toMatchObject({
      value: 420,
      source: 'Health Connect',
    });
    expect(pick(rows, '2026-10-02', 'active_calories')).toMatchObject({
      value: 300,
      source: 'workouts',
    });
    expect(pick(rows, '2026-10-03', 'active_calories')).toMatchObject({
      value: 610,
      source: 'garmin',
    });
  });

  it('never counts more sleep than time in bed', () => {
    const rows = mergeDaily({
      ...empty,
      sleep: [
        {
          entry_date: '2026-10-01',
          duration_in_seconds: 22980,
          time_asleep_in_seconds: 40965,
          source: 'Health Connect',
        },
      ],
    });
    expect(pick(rows, '2026-10-01', 'sleep')!.value).toBeCloseTo(6.383, 2);
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
