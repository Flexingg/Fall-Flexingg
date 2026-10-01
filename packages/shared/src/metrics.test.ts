import { describe, expect, it } from 'vitest';
import {
  adherenceScore,
  epley1rm,
  isMetricKey,
  metricDef,
  relativeSeries,
  weightGoalSeries,
} from './metrics.js';

describe('adherenceScore', () => {
  it('scores closeness to each person’s own goal, so bulking and cutting compete fairly', () => {
    expect(adherenceScore(3200, 3200)).toBe(100); // bulker on target
    expect(adherenceScore(1800, 1800)).toBe(100); // cutter on target
    expect(adherenceScore(2200, 2000)).toBe(80); // 10% over
    expect(adherenceScore(1800, 2000)).toBe(80); // 10% under
    expect(adherenceScore(3000, 2000)).toBe(0); // 50% over: floor
    expect(adherenceScore(2000, 0)).toBeNull();
    expect(adherenceScore(2000, null)).toBeNull();
  });
});

describe('weightGoalSeries', () => {
  const rows = [
    { date: '2026-09-28', value: 90 },
    { date: '2026-10-01', value: 89 },
    { date: '2026-10-05', value: 87.3 },
    { date: '2026-10-09', value: 85 },
  ];
  it('measures progress toward a loss target from the last weigh-in before the start', () => {
    const s = weightGoalSeries(
      rows,
      { direction: 'lose', targetType: 'kg', target: 4.5 },
      '2026-09-30',
    );
    expect(s.map((r) => [r.date, Math.round(r.value)])).toEqual([
      ['2026-10-01', 22],
      ['2026-10-05', 60],
      ['2026-10-09', 100], // 5 kg lost of 4.5: capped
    ]);
  });

  it('handles gain targets in percent, and going the wrong way', () => {
    const s = weightGoalSeries(
      [
        { date: '2026-10-01', value: 60 },
        { date: '2026-10-08', value: 61.5 },
        { date: '2026-10-15', value: 59.4 },
      ],
      { direction: 'gain', targetType: 'percent', target: 5 },
      '2026-10-01',
    );
    expect(s.map((r) => Math.round(r.value))).toEqual([0, 50, -20]);
  });

  it('is empty without any weigh-in', () => {
    expect(
      weightGoalSeries([], { direction: 'lose', targetType: 'kg', target: 3 }, '2026-10-01'),
    ).toEqual([]);
  });
});

describe('strength helpers', () => {
  it('estimates a one-rep max with Epley', () => {
    expect(epley1rm(100, 1)).toBe(100);
    expect(epley1rm(100, 5)).toBeCloseTo(116.67, 1);
    expect(epley1rm(0, 5)).toBe(0);
  });

  it('turns e1RM into % gain from each person’s own start', () => {
    const s = relativeSeries(
      [
        { date: '2026-09-20', value: 100 },
        { date: '2026-10-03', value: 105 },
        { date: '2026-10-10', value: 110 },
      ],
      '2026-10-01',
    );
    expect(s).toEqual([
      { date: '2026-10-03', value: 5 },
      { date: '2026-10-10', value: 10 },
    ]);
  });

  it('names per-exercise metrics and only takes lower-case keys', () => {
    expect(isMetricKey('lift_max:bench press')).toBe(true);
    expect(isMetricKey('lift_max:Bench')).toBe(false);
    expect(isMetricKey('lift_max:')).toBe(false);
    expect(isMetricKey('weight')).toBe(false); // raw weight is never a challenge metric
    expect(metricDef('lift_max:bench press').label).toBe('Bench Press max');
    expect(metricDef('lift_e1rm:squat')).toMatchObject({ unit: '%', transform: 'relative' });
    expect(metricDef('weight_goal')).toMatchObject({ source: 'weight', aggregate: 'last' });
  });
});
