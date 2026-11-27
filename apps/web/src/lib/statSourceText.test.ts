import type { PhoneAppShare, StatCandidate } from '@gauntlet/shared';
import { describe, expect, it } from 'vitest';
import { joinNames, overlapHint, usesSourceOrder, whyThisSource } from './statSourceText';

const cand = (n: number): StatCandidate[] =>
  Array.from({ length: n }, (_, i) => ({
    sourceKey: `s${i}`,
    label: `S${i}`,
    value: i,
    chosen: i === 0,
  }));
const base = {
  value: 9000,
  label: 'Steps',
  source: { key: 'garmin', label: 'Garmin' },
  order: undefined as 'metric' | 'default' | undefined,
};

describe('why this source counts', () => {
  it('says whose order it was', () => {
    expect(whyThisSource({ ...base, rule: 'priority', order: 'metric', candidates: cand(2) })).toBe(
      'Your source order for Steps puts Garmin first.',
    );
    expect(
      whyThisSource({ ...base, rule: 'priority', order: 'default', candidates: cand(2) }),
    ).toBe('Your default source order puts Garmin first.');
  });

  it('explains highest, only, preferred, first and combined', () => {
    expect(whyThisSource({ ...base, rule: 'highest', candidates: cand(3) })).toMatch(
      /^Highest of 3 sources\. .*never added together\.$/,
    );
    expect(whyThisSource({ ...base, rule: 'only', candidates: cand(1) })).toBe(
      'Only Garmin had this.',
    );
    expect(whyThisSource({ ...base, rule: 'preferred', candidates: cand(2) })).toBe(
      'Gauntlet prefers Garmin for this stat.',
    );
    expect(whyThisSource({ ...base, rule: 'first', candidates: cand(2) })).toBe(
      'Garmin was the first source to report it.',
    );
    expect(whyThisSource({ ...base, rule: 'combined', candidates: cand(4) })).toBe(
      'Worked out by adding up 4 entries.',
    );
  });

  it('handles old values, direct mode and no value', () => {
    expect(whyThisSource({ ...base, rule: null, candidates: [] })).toBe(
      'Counted from Garmin. More detail about why appears after your next sync.',
    );
    expect(whyThisSource({ ...base, rule: null, candidates: [] }, { direct: true })).toMatch(
      /on this phone/,
    );
    expect(whyThisSource({ ...base, value: null, source: null, rule: null, candidates: [] })).toBe(
      'Nothing has been recorded for this stat on this day.',
    );
  });

  it('only offers the source-order link when the order matters', () => {
    expect(usesSourceOrder({ rule: 'priority', candidates: cand(2) })).toBe(true);
    expect(usesSourceOrder({ rule: 'highest', candidates: cand(2) })).toBe(true);
    expect(usesSourceOrder({ rule: 'only', candidates: cand(1) })).toBe(false);
    expect(usesSourceOrder({ rule: null, candidates: [] })).toBe(false);
  });
});

describe('overlap hint', () => {
  const app = (name: string, value: number): PhoneAppShare => ({
    name,
    packageName: `pkg.${name}`,
    value,
    records: 1,
    devices: [],
  });
  it('names the apps that both wrote it', () => {
    expect(overlapHint('Steps', [app('Fitbit', 5), app('Samsung Health', 3)])).toBe(
      "Fitbit and Samsung Health both wrote steps for this day. Health Connect counts each one only once, using its own app priority. If this looks too high, check Health Connect's data sources.",
    );
    expect(overlapHint('Steps', [app('A', 1), app('B', 1), app('C', 1)])).toMatch(
      /^A, B and C all wrote steps/,
    );
  });
  it('is quiet for one app, or apps that wrote nothing', () => {
    expect(overlapHint('Steps', [app('Fitbit', 5)])).toBeNull();
    expect(overlapHint('Steps', [app('Fitbit', 5), app('Other', 0)])).toBeNull();
  });
  it('joins names', () => {
    expect(joinNames(['a'])).toBe('a');
    expect(joinNames(['a', 'b', 'c'])).toBe('a, b and c');
  });
});
