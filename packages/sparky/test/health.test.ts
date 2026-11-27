import { describe, expect, it } from 'vitest';
import { mergeDailyDetailed, type MergeInput } from '../src/merge.js';

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

const get = (r: ReturnType<typeof mergeDailyDetailed>, date: string, metric: string) =>
  r.values.find((v) => v.date === date && v.metric === metric);

const cat = (name: string, rows: [string, number, string?][], frequency = 'Daily') => ({
  category: { id: `c-${name}`, name, frequency },
  rows: rows.map(([date, value, ts]) => ({ date, value, timestamp: ts ?? `${date}T08:00:00Z` })),
});

describe('health readings', () => {
  it('reads custom categories under their Gauntlet keys using the metric aggregate', () => {
    const r = mergeDailyDetailed({
      ...empty,
      custom: {
        hrv: cat('hrv', [['2026-10-01', 48.2]]),
        // Several readings in one day, "sum" for floors and "min" for the lowest heart rate.
        floors_climbed: cat(
          'floors_climbed',
          [
            ['2026-10-01', 4],
            ['2026-10-01', 6],
          ],
          'All',
        ),
        heart_rate_min: cat(
          'heart_rate_min',
          [
            ['2026-10-01', 52],
            ['2026-10-01', 49],
          ],
          'All',
        ),
        oxygen_saturation: cat('oxygen_saturation', [['2026-10-02', 97]]),
      },
    });
    expect(get(r, '2026-10-01', 'hrv')?.value).toBe(48.2);
    expect(get(r, '2026-10-01', 'floors')?.value).toBe(10);
    expect(get(r, '2026-10-01', 'hr_min')?.value).toBe(49);
    expect(get(r, '2026-10-02', 'spo2')?.value).toBe(97);
    expect(r.values.some((v) => v.metric.startsWith('custom:'))).toBe(false);
  });

  it('reads body fat, height and resting energy from check-ins, total calories from the daily row', () => {
    const r = mergeDailyDetailed({
      ...empty,
      checkIns: [
        {
          entry_date: '2026-10-01',
          body_fat_percentage: 19.5,
          height: '180',
          bmr: 1700,
          updated_at: '2026-10-01T10:00:00Z',
        },
      ],
      daily: [
        { entry_date: '2026-10-01', source_provider: 'health_connect', total_calories: 2500 },
      ],
    });
    expect(get(r, '2026-10-01', 'body_fat')).toMatchObject({ value: 19.5, source: 'check-in' });
    expect(get(r, '2026-10-01', 'height')?.value).toBe(180);
    expect(get(r, '2026-10-01', 'bmr')?.value).toBe(1700);
    expect(get(r, '2026-10-01', 'total_calories')?.value).toBe(2500);
  });
});

describe('merge detail', () => {
  it('says only when one source had it', () => {
    const r = mergeDailyDetailed({
      ...empty,
      daily: [{ entry_date: '2026-10-01', source_provider: 'garmin', total_steps: 5000 }],
    });
    expect(get(r, '2026-10-01', 'steps')?.detail).toEqual({
      rule: 'only',
      candidates: [{ source: 'garmin', value: 5000 }],
    });
  });

  it('lists every source and says highest', () => {
    const r = mergeDailyDetailed({
      ...empty,
      daily: [{ entry_date: '2026-10-01', source_provider: 'garmin', total_steps: 9000.4 }],
      checkIns: [{ entry_date: '2026-10-01', steps: 8000, updated_at: 'x' }],
    });
    expect(get(r, '2026-10-01', 'steps')?.detail).toEqual({
      rule: 'highest',
      candidates: [
        { source: 'garmin', value: 9000.4 },
        { source: 'check-in', value: 8000 },
      ],
    });
  });

  it('says priority, and whose order', () => {
    const input: MergeInput = {
      ...empty,
      daily: [{ entry_date: '2026-10-01', source_provider: 'garmin', total_steps: 9000 }],
      checkIns: [{ entry_date: '2026-10-01', steps: 8000, updated_at: 'x' }],
    };
    const mine = mergeDailyDetailed({ ...input, priorities: { steps: ['health_connect'] } });
    expect(get(mine, '2026-10-01', 'steps')).toMatchObject({ value: 8000, source: 'check-in' });
    expect(get(mine, '2026-10-01', 'steps')?.detail).toMatchObject({
      rule: 'priority',
      order: 'metric',
    });
    const all = mergeDailyDetailed({ ...input, priorities: { '*': ['health_connect'] } });
    expect(get(all, '2026-10-01', 'steps')?.detail).toMatchObject({
      rule: 'priority',
      order: 'default',
    });
  });

  it('says preferred when a built-in preference beats a bigger number', () => {
    const r = mergeDailyDetailed({
      ...empty,
      daily: [{ entry_date: '2026-10-01', source_provider: 'garmin', resting_heart_rate: 58 }],
      custom: { resting_heart_rate: cat('resting_heart_rate', [['2026-10-01', 61]]) },
    });
    expect(get(r, '2026-10-01', 'resting_hr')).toMatchObject({ value: 58, source: 'garmin' });
    expect(get(r, '2026-10-01', 'resting_hr')?.detail?.rule).toBe('preferred');
  });

  it('says first for custom measurements and combined for totals worked out from entries', () => {
    const r = mergeDailyDetailed({
      ...empty,
      customMetrics: { mood: 'avg' },
      custom: { mood: cat('Mood', [['2026-10-01', 4]]) },
      nutrition: [{ date: '2026-10-01', calories: 2000, protein: 120, carbs: 200, fat: 70 }],
      water: [
        { entry_date: '2026-10-01', water_ml: 500 },
        { entry_date: '2026-10-01', water_ml: 750 },
      ],
      exerciseEntries: [
        {
          entry_date: '2026-10-01',
          exercise_name: 'Squat',
          exercise_source: 'Hevy',
          sets: [
            { set_type: 'normal', reps: 5, weight: 100 },
            { set_type: 'normal', reps: 5, weight: 100 },
          ],
        },
      ],
    });
    expect(get(r, '2026-10-01', 'custom:mood')?.detail?.rule).toBe('only');
    for (const m of ['calories_in', 'protein', 'water', 'lift_volume', 'lift_sets'])
      expect(get(r, '2026-10-01', m)?.detail?.rule, m).toBe('combined');
    expect(get(r, '2026-10-01', 'water')?.detail?.candidates).toEqual([
      { source: 'water', value: 1.25 },
    ]);
  });

  it('keeps the values themselves unchanged by detail', () => {
    const r = mergeDailyDetailed({
      ...empty,
      daily: [{ entry_date: '2026-10-01', source_provider: 'garmin', total_steps: 9000 }],
    });
    expect(get(r, '2026-10-01', 'steps')).toMatchObject({
      date: '2026-10-01',
      metric: 'steps',
      value: 9000,
      source: 'garmin',
    });
  });
});
