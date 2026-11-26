import { describe, expect, it } from 'vitest';
import {
  buildWeekGrid,
  compactNumber,
  heatLevel,
  heatThresholds,
  longestStepStreak,
  parsePeriod,
  periodTotals,
  previousMonth,
  reviewsToOffer,
  weekdayPattern,
} from './review.js';

describe('parsePeriod', () => {
  it('reads months, with leap years and the previous month', () => {
    expect(parsePeriod('2026-11')).toMatchObject({
      kind: 'month',
      start: '2026-11-01',
      end: '2026-11-30',
      label: 'November 2026',
      prevLabel: 'October',
      prev: { id: '2026-10', start: '2026-10-01', end: '2026-10-31' },
    });
    expect(parsePeriod('2024-02')!.end).toBe('2024-02-29');
    expect(parsePeriod('2026-01')!.prev).toEqual({
      id: '2025-12',
      start: '2025-12-01',
      end: '2025-12-31',
    });
  });
  it('reads years', () => {
    expect(parsePeriod('2026')).toMatchObject({
      kind: 'year',
      start: '2026-01-01',
      end: '2026-12-31',
      label: '2026',
      prev: { id: '2025', start: '2025-01-01', end: '2025-12-31' },
    });
  });
  it('refuses anything else', () => {
    for (const bad of [
      '',
      '2026-13',
      '2026-00',
      '26-11',
      '2026-1',
      'last-month',
      '1850',
      '2026-11-05',
    ])
      expect(parsePeriod(bad)).toBeNull();
  });
  it('steps back a month across a year', () => {
    expect(previousMonth('2026-01')).toBe('2025-12');
    expect(previousMonth('2026-11')).toBe('2026-10');
  });
});

describe('reviewsToOffer', () => {
  it('offers last month in the first week, and the year from 1 Dec to 7 Jan', () => {
    expect(reviewsToOffer('2026-11-03')).toEqual({ month: '2026-10', year: null });
    expect(reviewsToOffer('2026-11-08')).toEqual({ month: null, year: null });
    expect(reviewsToOffer('2026-12-20')).toEqual({ month: null, year: '2026' });
    expect(reviewsToOffer('2026-12-02')).toEqual({ month: '2026-11', year: '2026' });
    expect(reviewsToOffer('2027-01-05')).toEqual({ month: '2026-12', year: '2026' });
    expect(reviewsToOffer('2027-01-09')).toEqual({ month: null, year: null });
  });
});

const rows = (list: [string, number][], metric = 'steps') =>
  list.map(([date, value]) => ({ date, metric, value }));

describe('review numbers', () => {
  it('totals a period against the one before it', () => {
    const p = parsePeriod('2026-11')!;
    const t = periodTotals(
      [
        ...rows([
          ['2026-10-31', 1000],
          ['2026-11-01', 1500],
          ['2026-11-02', 500],
        ]),
        ...rows([['2026-11-02', 3]], 'workouts'),
      ],
      p,
    );
    expect(t.find((x) => x.key === 'steps')).toMatchObject({
      value: 2000,
      previous: 1000,
      changePct: 100,
    });
    expect(t.find((x) => x.key === 'workouts')).toMatchObject({
      value: 3,
      previous: 0,
      changePct: null,
    });
  });

  it('finds the longest 10k streak and ignores gaps', () => {
    const r = rows([
      ['2026-11-01', 12000],
      ['2026-11-02', 11000],
      ['2026-11-03', 9000],
      ['2026-11-04', 10000],
      ['2026-11-05', 10500],
      ['2026-11-06', 14000],
    ]);
    expect(longestStepStreak(r, '2026-11-01', '2026-11-30')).toEqual({
      days: 3,
      start: '2026-11-04',
      end: '2026-11-06',
    });
    expect(longestStepStreak(rows([['2026-11-01', 100]]), '2026-11-01', '2026-11-30')).toBeNull();
  });

  it('picks the weekday you move most, once there are enough days', () => {
    // 2026-11-02 is a Monday. Saturdays are big.
    const list: [string, number][] = [];
    for (let i = 0; i < 28; i++) {
      const d = new Date(Date.UTC(2026, 10, 2 + i));
      list.push([d.toISOString().slice(0, 10), d.getUTCDay() === 6 ? 16000 : 8000]);
    }
    expect(weekdayPattern(rows(list), '2026-11-01', '2026-11-30')).toEqual({
      name: 'Saturday',
      avgSteps: 16000,
      overallAvg: 9143,
    });
    expect(weekdayPattern(rows(list.slice(0, 5)), '2026-11-01', '2026-11-30')).toBeNull();
  });

  it('writes big numbers short', () => {
    expect(compactNumber(2_410_000)).toBe('2.4M');
    expect(compactNumber(38_500)).toBe('38.5k');
    expect(compactNumber(412)).toBe('412');
  });
});

describe('heatmap levels', () => {
  const values = Array.from({ length: 100 }, (_, i) => i + 1);
  it('uses the quartiles of the days that have a value', () => {
    expect(heatThresholds([0, 0, ...values])).toEqual([25, 50, 75]);
    expect(heatThresholds([])).toEqual([0, 0, 0]);
  });
  it('gives five levels: none, then four relative to your own range', () => {
    const t = heatThresholds(values);
    expect([0, 1, 25, 26, 50, 51, 75, 76, 100].map((v) => heatLevel(v, t))).toEqual([
      0, 1, 1, 2, 2, 3, 3, 4, 4,
    ]);
    expect(heatLevel(-5, t)).toBe(0);
  });
  it('treats a person whose days are all the same as all big days', () => {
    const t = heatThresholds([5000, 5000, 5000]);
    expect(heatLevel(5000, t)).toBe(4);
    expect(heatLevel(0, t)).toBe(0);
  });
});

describe('buildWeekGrid', () => {
  it('puts Monday at the top and pads the first and last week', () => {
    // 2026-11-04 is a Wednesday; 2026-11-16 is a Monday.
    const g = buildWeekGrid('2026-11-04', '2026-11-16');
    expect(g.weeks).toHaveLength(3);
    expect(g.weeks[0]).toEqual([
      null,
      null,
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
    ]);
    expect(g.weeks[2]).toEqual(['2026-11-16', null, null, null, null, null, null]);
  });
  it('covers a whole year with month labels at the right columns', () => {
    const g = buildWeekGrid('2025-11-27', '2026-11-26');
    const dates = g.weeks.flat().filter(Boolean);
    expect(dates).toHaveLength(365);
    expect(g.weeks.every((w) => w.length === 7)).toBe(true);
    expect(g.weeks.length).toBe(53);
    const labels = g.monthLabels.map((m) => m.label);
    expect(labels).toEqual([
      'Dec',
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
    ]);
    // The label sits on the column holding that month's 1st.
    const jan = g.monthLabels.find((m) => m.label === 'Jan')!;
    expect(g.weeks[jan.week]).toContain('2026-01-01');
  });
  it('handles an empty range', () => {
    expect(buildWeekGrid('2026-11-05', '2026-11-04')).toEqual({ weeks: [], monthLabels: [] });
  });
});
