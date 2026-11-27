import { describe, expect, it } from 'vitest';
import {
  describeSpan,
  HISTORY_MAX_DAYS,
  planChunks,
  requestedDays,
  startHistorySchema,
  windowDays,
} from './history.js';

describe('planChunks', () => {
  it('goes newest first in consecutive windows that cover the range exactly once', () => {
    const w = planChunks('2026-01-01', '2026-03-31', 30);
    expect(w[0]).toEqual({ start: '2026-03-02', end: '2026-03-31' });
    expect(w.at(-1)!.start).toBe('2026-01-01');
    expect(w.reduce((n, x) => n + windowDays(x), 0)).toBe(90);
    for (let i = 1; i < w.length; i++) expect(w[i]!.end < w[i - 1]!.start).toBe(true);
  });
  it('handles a range smaller than one chunk, one day, and nonsense', () => {
    expect(planChunks('2026-03-01', '2026-03-05', 90)).toEqual([
      { start: '2026-03-01', end: '2026-03-05' },
    ]);
    expect(planChunks('2026-03-01', '2026-03-01', 7)).toHaveLength(1);
    expect(planChunks('2026-03-05', '2026-03-01', 7)).toEqual([]);
    expect(planChunks('2026-03-01', '2026-03-05', 0)).toEqual([]);
  });
  it('plans five years in the expected number of chunks', () => {
    const w = planChunks('2021-11-27', '2026-11-27', 90);
    expect(w.reduce((n, x) => n + windowDays(x), 0)).toBe(1827);
    expect(w).toHaveLength(21);
  });
});

describe('requestedDays', () => {
  it('turns years into days and caps at five years', () => {
    expect(requestedDays({ years: 1 })).toBe(365);
    expect(requestedDays({ years: 5 })).toBe(HISTORY_MAX_DAYS);
    expect(requestedDays({ days: 90 })).toBe(90);
    expect(requestedDays({ days: 99999 })).toBe(HISTORY_MAX_DAYS);
  });
});

describe('startHistorySchema', () => {
  it('needs exactly one of years or days, and rejects more than five years', () => {
    expect(startHistorySchema.safeParse({ years: 2 }).success).toBe(true);
    expect(startHistorySchema.safeParse({ days: 400, sources: ['garmin', 'sparky'] }).success).toBe(
      true,
    );
    expect(startHistorySchema.safeParse({}).success).toBe(false);
    expect(startHistorySchema.safeParse({ years: 1, days: 30 }).success).toBe(false);
    expect(startHistorySchema.safeParse({ years: 6 }).success).toBe(false);
    expect(startHistorySchema.safeParse({ days: 2000 }).success).toBe(false);
    expect(startHistorySchema.safeParse({ days: 30, sources: ['nope'] }).success).toBe(false);
  });
});

describe('describeSpan', () => {
  it('reads like a person would say it', () => {
    expect(describeSpan('2022-09-27', '2026-11-27')).toBe('4 years 2 months');
    expect(describeSpan('2025-11-27', '2026-11-27')).toBe('1 year');
    expect(describeSpan('2026-06-27', '2026-11-27')).toBe('5 months');
    expect(describeSpan('2026-11-01', '2026-11-27')).toBe('3 weeks');
    expect(describeSpan('2026-11-26', '2026-11-27')).toBe('1 day');
    expect(describeSpan('2026-11-27', '2026-11-27')).toBe('0 days');
  });
});
