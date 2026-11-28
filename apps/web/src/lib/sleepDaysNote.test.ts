import { describe, expect, it } from 'vitest';
import { sleepDaysNote } from './sleepDaysNote';

const range = { from: '2026-10-01', to: '2026-10-07' };
const night = (date: string) => ({ type: 'SleepSession', entry_date: date });
const base = {
  read: [{}, {}],
  cap: 1000,
  sleepAllowed: null as boolean | null,
  range,
  records: [night('2026-10-02'), night('2026-10-05'), { type: 'step', date: '2026-10-03' }],
};

describe('sleepDaysNote', () => {
  it('lists the nights the read holds, inside the range', () => {
    expect(
      sleepDaysNote({
        ...base,
        records: [...base.records, night('2026-09-30'), night('2026-10-02')],
      }),
    ).toEqual({ ...range, dates: ['2026-10-02', '2026-10-05'] });
  });

  it('is never made when the sleep read failed', () => {
    expect(sleepDaysNote({ ...base, read: null })).toBeNull();
  });

  it('is never made when the read hit the cap (older nights may be missing)', () => {
    expect(sleepDaysNote({ ...base, read: new Array(1000).fill({}) })).toBeNull();
  });

  it('needs sleep access to trust an empty read', () => {
    const empty = { ...base, read: [], records: [] };
    expect(sleepDaysNote({ ...empty, sleepAllowed: null })).toBeNull();
    expect(sleepDaysNote({ ...empty, sleepAllowed: false })).toBeNull();
    expect(sleepDaysNote({ ...empty, sleepAllowed: true })).toEqual({ ...range, dates: [] });
  });
});
