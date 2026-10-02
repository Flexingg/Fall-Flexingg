import { describe, expect, it } from 'vitest';
import {
  computeStandings,
  ordinal,
  progressSeries,
  validateRules,
  type ScoringRules,
} from './scoring.js';

const base: ScoringRules = {
  scoring: 'total',
  aggregate: 'sum',
  lowerIsBetter: false,
  startDate: '2026-10-01',
  endDate: '2026-10-03',
  asOf: '2026-10-03',
};

const series = (userId: string, values: (number | null)[]) => ({
  userId,
  days: values.flatMap((v, i) => (v == null ? [] : [{ date: `2026-10-0${i + 1}`, value: v }])),
});

describe('computeStandings', () => {
  it('ranks totals and shares ranks on ties', () => {
    const s = computeStandings(base, [
      series('a', [1, 2, 3]),
      series('b', [6, 0, 0]),
      series('c', [1, 1, 1]),
    ]);
    expect(s.map((r) => [r.userId, r.rank, r.score])).toEqual([
      ['a', 1, 6],
      ['b', 1, 6],
      ['c', 3, 3],
    ]);
  });

  it('ignores days outside the window and after asOf', () => {
    const s = computeStandings({ ...base, asOf: '2026-10-02' }, [
      {
        userId: 'a',
        days: [
          { date: '2026-09-30', value: 100 },
          { date: '2026-10-01', value: 1 },
          { date: '2026-10-03', value: 50 },
        ],
      },
    ]);
    expect(s[0]!.score).toBe(1);
    expect(s[0]!.todayValue).toBeNull();
  });

  it('puts participants without data last', () => {
    const s = computeStandings({ ...base, aggregate: 'avg' }, [
      series('none', []),
      series('a', [7, 8, null]),
    ]);
    expect(s.map((r) => r.userId)).toEqual(['a', 'none']);
    expect(s[0]!.score).toBe(7.5);
    expect(s[1]!.score).toBeNull();
  });

  it('lower is better for resting heart rate', () => {
    const s = computeStandings({ ...base, aggregate: 'avg', lowerIsBetter: true }, [
      series('a', [60, 62, 61]),
      series('b', [52, 54, 53]),
    ]);
    expect(s[0]!.userId).toBe('b');
    expect(s[0]!.score).toBe(53);
  });

  it('race to goal ranks by the day the goal was reached', () => {
    const s = computeStandings({ ...base, scoring: 'race_to_goal', goal: 10 }, [
      series('slow', [3, 4, 30]),
      series('fast', [10, 0, 0]),
      series('none', [1, 1, 1]),
    ]);
    expect(s.map((r) => [r.userId, r.reachedGoalOn])).toEqual([
      ['fast', '2026-10-01'],
      ['slow', '2026-10-03'],
      ['none', null],
    ]);
    expect(s[2]!.progress).toBeCloseTo(0.3);
  });

  it('daily average divides by elapsed days, counting missing days as zero', () => {
    const s = computeStandings({ ...base, scoring: 'daily_avg' }, [series('a', [9, null, 0])]);
    expect(s[0]!.score).toBe(3);
  });

  it('best day picks the single best value', () => {
    const s = computeStandings({ ...base, scoring: 'best_day' }, [
      series('a', [5, 9, 2]),
      series('b', [8, 8, 8]),
    ]);
    expect(s.map((r) => [r.userId, r.score])).toEqual([
      ['a', 9],
      ['b', 8],
    ]);
  });

  it('streak counts consecutive days hitting the target', () => {
    const s = computeStandings(
      { ...base, scoring: 'streak', goal: 5, endDate: '2026-10-05', asOf: '2026-10-05' },
      [series('a', [5, 6, 1, 7, 8]), series('b', [9, 9, 9, null, 9])],
    );
    expect(s.map((r) => [r.userId, r.score])).toEqual([
      ['b', 3],
      ['a', 2],
    ]);
  });
});

describe('validateRules', () => {
  it('requires a goal for races and streaks', () => {
    expect(validateRules({ scoring: 'race_to_goal', aggregate: 'sum', goal: null })).toMatch(
      /goal/,
    );
    expect(validateRules({ scoring: 'race_to_goal', aggregate: 'avg', goal: 5 })).toMatch(/add up/);
    expect(validateRules({ scoring: 'streak', aggregate: 'sum' })).toMatch(/target/);
    expect(validateRules({ scoring: 'total', aggregate: 'sum' })).toBeNull();
  });
});

describe('ordinal', () => {
  it('formats', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '101st',
    ]);
  });
});

describe('"last" metrics (running figures like % toward a target)', () => {
  const rules = {
    aggregate: 'last' as const,
    lowerIsBetter: false,
    startDate: '2026-01-01',
    endDate: '2026-01-10',
    asOf: '2026-01-05',
  };
  const series = [
    {
      userId: 'a',
      days: [
        { date: '2026-01-01', value: 10 },
        { date: '2026-01-04', value: 60 },
      ],
    },
    {
      userId: 'b',
      days: [
        { date: '2026-01-02', value: 80 },
        { date: '2026-01-05', value: 40 },
      ],
    },
  ];

  it('total scores the latest value', () => {
    const s = computeStandings({ ...rules, scoring: 'total' }, series);
    expect(s.map((x) => [x.userId, x.score])).toEqual([
      ['a', 60],
      ['b', 40],
    ]);
  });

  it('race to target is won by the first to reach it, not by adding days up', () => {
    const s = computeStandings({ ...rules, scoring: 'race_to_goal', goal: 50 }, series);
    expect(s.map((x) => [x.userId, x.reachedGoalOn])).toEqual([
      ['b', '2026-01-02'],
      ['a', '2026-01-04'],
    ]);
    expect(validateRules({ scoring: 'race_to_goal', aggregate: 'last', goal: 100 })).toBeNull();
  });
});

describe('progressSeries', () => {
  const base = {
    aggregate: 'sum' as const,
    lowerIsBetter: false,
    startDate: '2026-01-01',
    endDate: '2026-01-10',
    asOf: '2026-01-06',
  };
  const people = [
    {
      userId: 'a',
      days: [
        { date: '2026-01-01', value: 5 },
        { date: '2026-01-02', value: 7 },
        { date: '2026-01-04', value: 3 },
        { date: '2026-01-06', value: 9 },
      ],
    },
    {
      userId: 'b',
      days: [
        { date: '2026-01-02', value: 10 },
        { date: '2026-01-03', value: 10 },
        { date: '2026-01-05', value: 1 },
      ],
    },
  ];

  it.each([
    ['total', {}],
    ['daily_avg', {}],
    ['best_day', {}],
    ['streak', { goal: 4 }],
    ['race_to_goal', { goal: 15 }],
  ] as const)('ends on the leaderboard score for %s', (scoring, extra) => {
    const rules = { ...base, scoring, ...extra };
    const { dates, series } = progressSeries(rules, people);
    expect(dates).toHaveLength(6);
    const final = computeStandings(rules, people);
    for (const s of series) {
      expect(s.values).toHaveLength(6);
      expect(s.values.at(-1)).toEqual(final.find((x) => x.userId === s.userId)!.score);
    }
  });

  it('grows day by day and starts empty for someone who has not logged yet', () => {
    const { series } = progressSeries({ ...base, scoring: 'total' }, people);
    expect(series[0]!.values).toEqual([5, 12, 12, 15, 15, 24]);
    expect(series[1]!.values).toEqual([0, 10, 20, 20, 21, 21]);
  });

  it('handles running figures (last) and lower-is-better', () => {
    const last = progressSeries({ ...base, aggregate: 'last', scoring: 'total' }, people).series[0]!
      .values;
    expect(last).toEqual([5, 7, 7, 3, 3, 9]);
    const hr = progressSeries(
      { ...base, aggregate: 'avg', lowerIsBetter: true, scoring: 'best_day' },
      people,
    ).series[0]!.values;
    expect(hr).toEqual([5, 5, 5, 3, 3, 3]);
  });
});
