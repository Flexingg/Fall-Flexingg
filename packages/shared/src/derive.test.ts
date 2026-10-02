import { describe, expect, it } from 'vitest';
import {
  buildOverview,
  buildToday,
  buildTrends,
  personalBests,
  trendDef,
  trendsNeedFrom,
  trendWindow,
  type MetricRow,
} from './derive.js';

// Thu 2026-10-01. Week = Mon Sep 28 .. Sun Oct 4.
const today = '2026-10-01';
const row = (date: string, metric: string, value: number): MetricRow => ({ date, metric, value });

describe('buildToday', () => {
  it('reports today only, with goals, and null for missing metrics', () => {
    const t = buildToday(
      [
        row(today, 'steps', 9412),
        row('2026-09-30', 'steps', 5000),
        row(today, 'active_calories', 612),
      ],
      today,
    );
    expect(t.metrics.map((m) => [m.key, m.value, m.goal])).toEqual([
      ['steps', 9412, 10000],
      ['active_calories', 612, 500],
      ['active_minutes', null, 30],
      ['distance', null, null],
    ]);
    expect(t.metrics[1]!.label).toBe('Active kcal');
  });
});

describe('trends', () => {
  const rows = [
    row('2026-09-21', 'steps', 1000),
    row('2026-09-22', 'steps', 1000),
    row('2026-09-23', 'steps', 1000),
    row('2026-09-24', 'steps', 1000),
    row('2026-09-28', 'steps', 2000),
    row('2026-09-29', 'steps', 3000),
    row('2026-09-30', 'steps', 4000),
    row(today, 'steps', 5000),
    row('2026-09-28', 'distance', 99),
  ];

  it('windows', () => {
    expect(trendWindow('week', today)).toEqual({ start: '2026-09-28', end: '2026-10-04' });
    expect(trendWindow('month', today)).toEqual({ start: '2026-09-02', end: today });
    expect(trendWindow('day', today)).toEqual({ start: '2026-09-25', end: today });
    expect(trendsNeedFrom('week', today)).toBe('2026-09-21');
  });

  it('totals the elapsed days of the week and compares with the same days last week', () => {
    const t = buildTrends({ rows, range: 'week', metric: 'steps', today });
    expect(t.total).toBe(14000);
    expect(t.previousTotal).toBe(4000);
    expect(t.changePct).toBeCloseTo(250);
    expect(t.bars.map((b) => b.label).join('')).toBe('MTWTFSS');
    expect(t.bars.map((b) => b.value)).toEqual([2000, 3000, 4000, 5000, 0, 0, 0]);
    expect(t.bars.find((b) => b.isToday)!.date).toBe(today);
  });

  it('averages sleep and resting heart rate instead of adding them', () => {
    const t = buildTrends({
      rows: [row('2026-09-28', 'sleep', 6), row('2026-09-29', 'sleep', 8)],
      range: 'week',
      metric: 'sleep',
      today,
    });
    expect(t.total).toBe(7);
  });

  it('has no percentage change without a previous period', () => {
    const t = buildTrends({
      rows: [row(today, 'steps', 10)],
      range: 'week',
      metric: 'steps',
      today,
    });
    expect(t.changePct).toBeNull();
  });
});

describe('personalBests', () => {
  const rows = [
    row('2026-09-25', 'steps', 21715),
    row('2026-09-26', 'steps', 12000),
    row('2026-09-27', 'steps', 10000),
    row('2026-09-29', 'steps', 10500),
    row('2026-09-30', 'steps', 9999),
    row('2026-09-27', 'distance', 17.44),
    row('2026-09-26', 'distance', 8),
    row('2026-09-20', 'workouts', 2),
    row('2026-09-28', 'workouts', 1),
    row('2026-08-01', 'workouts', 5),
  ];

  it('finds bests and the longest 10k-step streak', () => {
    const p = personalBests(rows, { today, challengesWon: 4 });
    expect(p).toEqual([
      { label: 'Best distance day', value: '17.4 km' },
      { label: 'Best step day', value: '21,715' },
      { label: '10k-step streak', value: '3 days' },
      { label: 'Challenges won', value: '4 wins' },
    ]);
  });

  it('falls back to recent workouts when there are no challenges', () => {
    expect(personalBests(rows, { today })[3]).toEqual({ label: 'Workouts, 30 days', value: '3' });
  });

  it('copes with no data at all', () => {
    expect(personalBests([], { today, challengesWon: 1 })).toEqual([
      { label: 'Best distance day', value: '–' },
      { label: 'Best step day', value: '–' },
      { label: '10k-step streak', value: '0 days' },
      { label: 'Challenges won', value: '1 win' },
    ]);
  });
});

describe('every stat on Trends', () => {
  const today = '2026-10-02'; // a Friday
  const rows = [
    { date: '2026-10-01', metric: 'steps', value: 9000 },
    { date: '2026-10-02', metric: 'steps', value: 11000 },
    { date: '2026-09-24', metric: 'steps', value: 8000 },
    { date: '2026-10-01', metric: 'weight', value: 82 },
    { date: '2026-10-02', metric: 'weight', value: 81.4 },
    { date: '2026-10-01', metric: 'lift_max:bench press', value: 80 },
    { date: '2026-10-02', metric: 'lift_max:bench press', value: 85 },
    { date: '2026-10-01', metric: 'custom:mood', value: 6 },
    { date: '2026-10-02', metric: 'custom:mood', value: 8 },
    { date: '2026-10-02', metric: 'calorie_adherence', value: 90 },
    // Stored goals and per-challenge scores are not stats.
    { date: '2026-10-02', metric: 'goal_calories', value: 2000 },
    { date: '2026-10-02', metric: 'weight_goal', value: 40 },
  ];

  it('knows how each kind of stat combines over a range', () => {
    expect(trendDef('steps')).toMatchObject({ aggregate: 'sum', group: 'activity' });
    expect(trendDef('sleep')).toMatchObject({ aggregate: 'avg' });
    expect(trendDef('weight')).toMatchObject({ aggregate: 'last', unit: 'kg', group: 'body' });
    expect(trendDef('lift_max:bench press')).toMatchObject({
      label: 'Bench Press heaviest set',
      aggregate: 'max',
      unit: 'kg',
    });
    expect(trendDef('lift_e1rm:squat')!.label).toBe('Squat est. 1RM');
    expect(trendDef('custom:mood')).toMatchObject({ label: 'Mood', group: 'custom' });
    expect(trendDef('goal_calories')).toBeNull();
    expect(trendDef('weight_goal')).toBeNull();
    expect(trendDef('nonsense')).toBeNull();
  });

  it('totals weight as the latest weigh-in and lifts as the best day', () => {
    const w = buildTrends({ rows, range: 'day', metric: 'weight', today });
    expect(w.total).toBe(81.4);
    expect(w.def.label).toBe('Weight');
    expect(buildTrends({ rows, range: 'day', metric: 'lift_max:bench press', today }).total).toBe(
      85,
    );
    expect(buildTrends({ rows, range: 'day', metric: 'custom:mood', today }).total).toBe(7);
    expect(buildTrends({ rows, range: 'day', metric: 'steps', today }).total).toBe(20000);
  });

  it('summarises every stat with data, and lists all that can be picked', () => {
    const o = buildOverview({ rows, range: 'day', today });
    expect(o.items.map((i) => i.key).sort()).toEqual(
      ['calorie_adherence', 'custom:mood', 'lift_max:bench press', 'steps', 'weight'].sort(),
    );
    expect(o.items.find((i) => i.key === 'steps')).toMatchObject({ total: 20000 });
    expect(o.available.map((a) => a.key)).toContain('lift_max:bench press');
    expect(o.available.some((a) => a.key.startsWith('goal_'))).toBe(false);
    // Grouped in the same order as the new-challenge picker.
    expect(o.items.map((i) => i.group)).toEqual([
      'activity',
      'strength',
      'nutrition',
      'body',
      'custom',
    ]);
  });
});
