import { describe, expect, it } from 'vitest';
import {
  buildToday,
  buildTrends,
  personalBests,
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
