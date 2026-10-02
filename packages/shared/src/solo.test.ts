import { describe, expect, it } from 'vitest';
import { soloProgress, soloScoring } from './solo.js';
import type { ScoringRules } from './scoring.js';

const rules = (over: Partial<ScoringRules>): ScoringRules => ({
  scoring: 'race_to_goal',
  aggregate: 'sum',
  lowerIsBetter: false,
  goal: 100,
  startDate: '2026-10-01',
  endDate: '2026-10-10',
  asOf: '2026-10-05',
  ...over,
});
const day = (n: number, value: number) => ({
  date: `2026-10-${String(n).padStart(2, '0')}`,
  value,
});

describe('solo: hit a total', () => {
  const r = rules({});
  it('is ahead, on track or behind an even pace, and says what each day must bring', () => {
    // Day 5 of 10 of a 100 target: an even pace is 50.
    const ahead = soloProgress({
      solo: { kind: 'target' },
      rules: r,
      days: [day(1, 30), day(2, 30)],
      today: '2026-10-05',
    });
    expect(ahead).toMatchObject({ status: 'ahead', current: 60, expected: 50, remaining: 40 });
    expect(ahead.perDayNeeded).toBeCloseTo(8, 5); // 40 over the 5 days left
    expect(
      soloProgress({ solo: { kind: 'target' }, rules: r, days: [day(1, 47)], today: '2026-10-05' })
        .status,
    ).toBe('on_track');
    expect(
      soloProgress({ solo: { kind: 'target' }, rules: r, days: [day(1, 20)], today: '2026-10-05' })
        .status,
    ).toBe('behind');
  });

  it('is achieved the moment it is reached, and missed if the end comes first', () => {
    expect(
      soloProgress({
        solo: { kind: 'target' },
        rules: r,
        days: [day(1, 60), day(2, 45)],
        today: '2026-10-05',
      }),
    ).toMatchObject({ status: 'achieved', progress: 1, remaining: 0 });
    const over = rules({ asOf: '2026-10-10' });
    expect(
      soloProgress({
        solo: { kind: 'target' },
        rules: over,
        days: [day(1, 70)],
        today: '2026-10-11',
      }),
    ).toMatchObject({
      status: 'missed',
      progress: 0.7,
      daysLeft: 0,
    });
  });

  it('has not started before its first day', () => {
    const p = soloProgress({
      solo: { kind: 'target' },
      rules: rules({ asOf: '2026-10-01' }),
      days: [],
      today: '2026-09-28',
    });
    expect(p).toMatchObject({ status: 'upcoming', daysElapsed: 0, daysTotal: 10 });
  });

  it('works for running figures like % toward a weight target', () => {
    const w = rules({ aggregate: 'last', goal: 100, asOf: '2026-10-05' });
    const p = soloProgress({
      solo: { kind: 'target' },
      rules: w,
      days: [day(2, 40), day(4, 65)],
      today: '2026-10-05',
    });
    expect(p).toMatchObject({ current: 65, progress: 0.65 });
  });
});

describe('solo: daily average', () => {
  const r = rules({ scoring: 'daily_avg', goal: 10, asOf: '2026-10-04' });
  it('compares the average so far with the goal', () => {
    // 4 elapsed days: 44 / 4 = 11 (10% over goal -> ahead), 40/4 = 10 (on track), 20/4 = 5 (behind).
    expect(
      soloProgress({
        solo: { kind: 'average' },
        rules: r,
        days: [day(1, 44)],
        today: '2026-10-04',
      }),
    ).toMatchObject({ status: 'ahead', current: 11 });
    expect(
      soloProgress({ solo: { kind: 'average' }, rules: r, days: [day(1, 40)], today: '2026-10-04' })
        .status,
    ).toBe('on_track');
    expect(
      soloProgress({
        solo: { kind: 'average' },
        rules: r,
        days: [day(1, 20)],
        today: '2026-10-04',
      }),
    ).toMatchObject({ status: 'behind', progress: 0.5 });
  });
  it('is judged at the end, and flips for lower-is-better stats', () => {
    const end = rules({ scoring: 'daily_avg', goal: 10, asOf: '2026-10-10' });
    expect(
      soloProgress({
        solo: { kind: 'average' },
        rules: end,
        days: [day(1, 100)],
        today: '2026-10-11',
      }).status,
    ).toBe('achieved');
    expect(
      soloProgress({
        solo: { kind: 'average' },
        rules: end,
        days: [day(1, 90)],
        today: '2026-10-11',
      }).status,
    ).toBe('missed');
    const lower = rules({
      scoring: 'daily_avg',
      aggregate: 'avg',
      lowerIsBetter: true,
      goal: 60,
      asOf: '2026-10-10',
    });
    expect(
      soloProgress({
        solo: { kind: 'average' },
        rules: lower,
        days: [day(1, 58), day(2, 59)],
        today: '2026-10-11',
      }).status,
    ).toBe('achieved');
  });
});

describe('solo: streak', () => {
  const r = rules({ scoring: 'streak', goal: 5, asOf: '2026-10-06' });
  const solo = { kind: 'streak' as const, days: 4 };
  it('tracks the best run and finishes when it is long enough', () => {
    const days = [day(1, 6), day(2, 7), day(3, 2), day(4, 5), day(5, 5), day(6, 9)];
    expect(soloProgress({ solo, rules: r, days, today: '2026-10-06' })).toMatchObject({
      current: 3,
      target: 4,
      valueKind: 'days',
      status: 'on_track',
    });
    const done = [...days.slice(0, 2), day(3, 8), day(4, 5), day(5, 5), day(6, 9)];
    expect(soloProgress({ solo, rules: r, days: done, today: '2026-10-06' })).toMatchObject({
      status: 'achieved',
      progress: 1,
    });
  });
  it('does not break the run for a day that is not over yet, and gives up when it can no longer be reached', () => {
    const open = soloProgress({
      solo: { kind: 'streak', days: 6 },
      rules: rules({ scoring: 'streak', goal: 5, asOf: '2026-10-04' }),
      days: [day(1, 6), day(2, 6), day(3, 6)],
      today: '2026-10-04',
    });
    expect(open.status).not.toBe('missed'); // today (the 4th) can still hit
    // 8 days to go would still allow it; with 2 days left and a long way to go it cannot.
    const late = soloProgress({
      solo: { kind: 'streak', days: 8 },
      rules: rules({ scoring: 'streak', goal: 5, asOf: '2026-10-08' }),
      days: [
        day(1, 6),
        day(2, 1),
        day(3, 6),
        day(4, 6),
        day(5, 6),
        day(6, 6),
        day(7, 1),
        day(8, 1),
      ],
      today: '2026-10-08',
    });
    expect(late.status).toBe('missed');
  });
});

describe('solo: beat my past self', () => {
  const r = rules({ scoring: 'daily_avg', goal: null, asOf: '2026-10-05' });
  const past = (v: number) => [
    { date: '2026-09-26', value: v },
    { date: '2026-09-27', value: v },
    { date: '2026-09-28', value: v },
    { date: '2026-09-29', value: v },
    { date: '2026-09-30', value: v },
  ];
  const solo = {
    kind: 'improve' as const,
    changePct: 10,
    direction: 'up' as const,
    baselineDays: 5,
  };

  it('measures % change against the same stat over the days before', () => {
    // Before: 100 a day. Now: 5 days at 120 -> +20%.
    const now = [day(1, 120), day(2, 120), day(3, 120), day(4, 120), day(5, 120)];
    const p = soloProgress({
      solo,
      rules: r,
      days: now,
      baselineDays: past(100),
      today: '2026-10-05',
    });
    expect(p.baseline).toEqual({ value: 100, from: '2026-09-26', to: '2026-09-30', days: 5 });
    expect(p.current).toBeCloseTo(20, 5);
    expect(p).toMatchObject({ status: 'ahead', valueKind: 'pct', target: 10, progress: 1 });
  });

  it('is on track, behind, achieved or missed', () => {
    const at = (v: number, today = '2026-10-05', asOf = '2026-10-05') =>
      soloProgress({
        solo,
        rules: { ...r, asOf },
        days: [day(1, v), day(2, v), day(3, v), day(4, v), day(5, v)],
        baselineDays: past(100),
        today,
      });
    expect(at(107).status).toBe('on_track'); // +7% of the 10% wanted
    expect(at(103).status).toBe('behind');
    const end = (v: number) =>
      soloProgress({
        solo,
        rules: { ...r, asOf: '2026-10-10' },
        days: Array.from({ length: 10 }, (_, i) => day(i + 1, v)),
        baselineDays: past(100),
        today: '2026-10-11',
      });
    expect(end(111).status).toBe('achieved');
    expect(end(105).status).toBe('missed');
  });

  it('can aim lower, e.g. cut my resting heart rate', () => {
    const lower = {
      ...rules({
        scoring: 'daily_avg',
        aggregate: 'avg',
        lowerIsBetter: true,
        goal: null,
        asOf: '2026-10-05',
      }),
    };
    const p = soloProgress({
      solo: { kind: 'improve', changePct: 5, direction: 'down', baselineDays: 5 },
      rules: lower,
      days: [day(1, 56), day(2, 56), day(3, 56)],
      baselineDays: past(60),
      today: '2026-10-05',
    });
    expect(p.current).toBeCloseTo(-6.6667, 3);
    expect(p).toMatchObject({ status: 'ahead', target: -5, direction: 'down' });
  });

  it('has nothing to compare with when there was no data before', () => {
    const p = soloProgress({
      solo,
      rules: r,
      days: [day(1, 120)],
      baselineDays: [],
      today: '2026-10-05',
    });
    expect(p).toMatchObject({ baseline: null, current: null, status: 'on_track' });
  });
});

describe('soloScoring', () => {
  it('maps each kind onto the shared engine', () => {
    expect(soloScoring('target')).toBe('race_to_goal');
    expect(soloScoring('average')).toBe('daily_avg');
    expect(soloScoring('streak')).toBe('streak');
    expect(soloScoring('improve')).toBe('daily_avg');
    expect(soloScoring('improve', { heaviest: true })).toBe('best_day');
  });
});
