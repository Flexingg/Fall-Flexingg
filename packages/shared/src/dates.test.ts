import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, isDateString, listDates, localDate } from './dates.js';

describe('dates', () => {
  it('walks across month and DST boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(listDates('2026-03-07', '2026-03-09')).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
    expect(listDates('2026-03-09', '2026-03-07')).toEqual([]);
    expect(daysBetween('2026-01-01', '2026-12-31')).toBe(364);
  });
  it('validates', () => {
    expect(isDateString('2026-02-29')).toBe(false);
    expect(isDateString('2028-02-29')).toBe(true);
    expect(isDateString('2026-1-01')).toBe(false);
  });
  it('resolves local date in a time zone', () => {
    const instant = new Date('2026-10-01T03:00:00Z');
    expect(localDate(instant, 'America/Los_Angeles')).toBe('2026-09-30');
    expect(localDate(instant, 'Europe/Berlin')).toBe('2026-10-01');
  });
});
