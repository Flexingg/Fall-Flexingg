import type { PhoneAppShare, StatCandidate } from '@gauntlet/shared';
import { describe, expect, it } from 'vitest';
import {
  appLabel,
  countedVsSum,
  filterText,
  joinNames,
  overlapHint,
  usesSourceOrder,
  whyThisSource,
} from './statSourceText';

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

const app = (name: string, value: number): PhoneAppShare => ({
  name,
  packageName: `pkg.${name}`,
  value,
  records: 1,
  devices: [],
});

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

describe('app names', () => {
  it('keeps a real name and shortens a raw package', () => {
    expect(appLabel('Garmin Connect', 'com.garmin.android.apps.connectmobile')).toBe(
      'Garmin Connect',
    );
    expect(appLabel('com.example.unknown', 'com.example.unknown')).toBe('Unknown');
    expect(
      appLabel(
        'com.android.healthconnect.phone.4f9c2e81aa',
        'com.android.healthconnect.phone.4f9c2e81aa',
      ),
    ).toBe('This phone');
    expect(appLabel('', 'com.acme.rings.4f9c2e81aa')).toBe('Rings');
  });
  it('never puts a raw package in the overlap sentence', () => {
    const long = 'com.android.healthconnect.phone.4f9c2e81aa';
    const hint = overlapHint('Steps', [
      { packageName: long, name: long, value: 5, records: 1, devices: [] },
      { packageName: 'com.fitbit.FitbitMobile', name: 'Fitbit', value: 5, records: 1, devices: [] },
    ]);
    expect(hint).toMatch(/^This phone and Fitbit both wrote steps/);
    expect(hint).not.toContain('com.');
  });
  it('says what counts and how the apps add up', () => {
    const apps = [app('Garmin Connect', 3000), app('Fitbit', 2300)];
    expect(filterText(['a.b.c'], [{ name: 'Garmin Connect', packageName: 'a.b.c' }])).toBe(
      'Counting Garmin Connect only',
    );
    expect(
      filterText(
        ['a.b.c', 'd.e.f'],
        [
          { name: 'Garmin Connect', packageName: 'a.b.c' },
          { name: 'Fitbit', packageName: 'd.e.f' },
        ],
      ),
    ).toBe('Counting Garmin Connect, then Fitbit');
    const fmt = (v: number) => String(v);
    expect(countedVsSum('steps', apps, 3500, fmt)).toMatch(
      /^Health Connect counted 3500\. Added up, these apps come to 5300/,
    );
    expect(countedVsSum('steps', apps, 5300, fmt)).toBeNull();
    expect(countedVsSum('weight', apps, 3500, fmt)).toBeNull();
  });
});
