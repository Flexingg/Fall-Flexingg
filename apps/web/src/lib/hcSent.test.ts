import { describe, expect, it } from 'vitest';
import { changedItems, fingerprint, originKey, parseSent, recordKey, remember } from './hcSent';

const rec = (value: number, date = '2026-05-01') => ({
  type: 'step',
  value,
  date,
  unit: 'count',
  source: 'Health Connect',
});

describe('fingerprint', () => {
  it('is stable and sensitive to content', () => {
    expect(fingerprint(rec(10))).toBe(fingerprint(rec(10)));
    expect(fingerprint(rec(10))).not.toBe(fingerprint(rec(11)));
  });
});

describe('recordKey / originKey', () => {
  it('uses type, day and the id', () => {
    expect(recordKey(rec(1))).toBe('step|2026-05-01|');
    expect(recordKey({ type: 'Water', source_id: 'w-1', date: '2026-05-01' })).toBe(
      'Water|2026-05-01|w-1',
    );
    expect(recordKey({ type: 'SleepSession', entry_date: '2026-05-02', timestamp: 'x' })).toBe(
      'SleepSession|2026-05-02|x',
    );
  });
  it('tells origins apart by metric and day', () => {
    expect(originKey({ metric: 'steps', date: '2026-05-01' })).toBe('origin:steps|2026-05-01|');
  });
});

describe('changedItems', () => {
  const sent = { [recordKey(rec(10))]: fingerprint(rec(10)) };
  it('skips what was already sent unchanged', () => {
    expect(changedItems([rec(10)], recordKey, sent, false)).toEqual([]);
  });
  it('keeps a changed value and a new day', () => {
    const got = changedItems([rec(12), rec(5, '2026-05-02')], recordKey, sent, false);
    expect(got.map((p) => p.item.value)).toEqual([12, 5]);
  });
  it('sends everything when asked to', () => {
    expect(changedItems([rec(10)], recordKey, sent, true)).toHaveLength(1);
  });
});

describe('remember', () => {
  it('stores what was sent and drops old days', () => {
    const old = { [recordKey(rec(1, '2026-04-01'))]: 'a', 'origin:steps|2026-04-02|': 'b' };
    const done = changedItems([rec(7)], recordKey, {}, false);
    const next = remember(old, done, '2026-04-20');
    expect(Object.keys(next)).toEqual(['step|2026-05-01|']);
    expect(next['step|2026-05-01|']).toBe(done[0]!.print);
  });
});

describe('parseSent', () => {
  it('survives junk', () => {
    expect(parseSent(null)).toEqual({});
    expect(parseSent('nope')).toEqual({});
    expect(parseSent('[1]')).toEqual({});
    expect(parseSent('{"a":"b"}')).toEqual({ a: 'b' });
  });
});
