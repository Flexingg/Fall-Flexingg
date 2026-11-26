import { describe, expect, it } from 'vitest';
import {
  bestStepDay,
  buildRecapTotals,
  isoWeekOf,
  isoWeekStart,
  isWeekId,
  previousIsoWeek,
} from './notifications.js';

describe('ISO weeks', () => {
  it('round-trips weeks and starts them on Monday', () => {
    for (const d of ['2026-01-01', '2026-06-15', '2026-11-22', '2026-12-31', '2027-01-03']) {
      const w = isoWeekOf(d);
      const start = isoWeekStart(w);
      expect(isoWeekOf(start)).toBe(w);
      expect(new Date(`${start}T00:00:00Z`).getUTCDay()).toBe(1);
      expect(
        d >= start &&
          d <=
            new Date(Date.parse(`${start}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10),
      ).toBe(true);
    }
    expect(isoWeekOf('2026-12-31')).toBe('2026-W53');
    expect(previousIsoWeek('2026-01-05')).toBe('2026-W01');
  });

  it('recognises week ids', () => {
    expect(isWeekId('2026-W48')).toBe(true);
    expect(isWeekId('2026-W00')).toBe(false);
    expect(isWeekId('2026-48')).toBe(false);
  });
});

describe('recap totals', () => {
  const rows = [
    { date: '2026-11-09', metric: 'steps', value: 1000 },
    { date: '2026-11-16', metric: 'steps', value: 3000 },
    { date: '2026-11-22', metric: 'steps', value: 1000 },
    { date: '2026-11-23', metric: 'steps', value: 99999 },
    { date: '2026-11-16', metric: 'distance', value: 2.5 },
  ];
  it('sums the week, compares with the one before and ignores other days', () => {
    const t = buildRecapTotals(rows, '2026-11-16');
    expect(t.find((x) => x.key === 'steps')).toMatchObject({
      value: 4000,
      previous: 1000,
      changePct: 300,
    });
    expect(t.find((x) => x.key === 'distance')).toMatchObject({ value: 2.5, changePct: null });
    expect(t.find((x) => x.key === 'workouts')!.value).toBe(0);
  });
  it('finds the best step day', () => {
    expect(bestStepDay(rows, '2026-11-16')).toEqual({ date: '2026-11-16', steps: 3000 });
    expect(bestStepDay([], '2026-11-16')).toBeNull();
  });
});
