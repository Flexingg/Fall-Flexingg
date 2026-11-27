import { HC_ORIGIN_METRICS } from '@gauntlet/shared';
import { describe, expect, it } from 'vitest';
import {
  buildOrigins,
  ORIGIN_SPECS,
  originsOfSamples,
  readCapOf,
  sleepOrigins,
  workoutOrigins,
  type OriginSample,
} from './hcOriginsRead';

// A fixed "time zone": the UTC day.
const dayOf = (iso: string) => iso.slice(0, 10);
const FIT = 'com.fitbit.FitbitMobile';
const FITNESS = 'com.google.android.apps.fitness';
const s = (
  value: number,
  at: string,
  sourceId: string | undefined,
  extra: Partial<OriginSample> = {},
): OriginSample => ({ value, startDate: at, endDate: at, sourceId, ...extra });

describe('origins from samples', () => {
  it('sums steps per app and counts records and devices', () => {
    const [o] = originsOfSamples(
      'steps',
      [
        s(100, '2026-10-01T08:00:00Z', FIT, { deviceType: 'watch' }),
        s(200, '2026-10-01T09:00:00Z', FIT, { deviceType: 'watch' }),
        s(150, '2026-10-01T10:00:00Z', FITNESS, { deviceType: 'phone' }),
        s(50, '2026-10-01T10:00:00Z', FITNESS),
      ],
      dayOf,
      { counted: new Map([['2026-10-01', 330]]), capped: false },
    );
    expect(o).toEqual({
      date: '2026-10-01',
      metric: 'steps',
      apps: [
        { packageName: FIT, value: 300, records: 2, devices: ['watch'] },
        { packageName: FITNESS, value: 200, records: 2, devices: ['phone'] },
      ],
      counted: 330,
      capped: false,
    });
  });

  it('splits days and leaves counted null without an aggregate', () => {
    const out = originsOfSamples(
      'steps',
      [s(10, '2026-10-01T08:00:00Z', FIT), s(20, '2026-10-02T08:00:00Z', FIT)],
      dayOf,
    );
    expect(out.map((o) => [o.date, o.apps[0]!.value, o.counted])).toEqual([
      ['2026-10-01', 10, null],
      ['2026-10-02', 20, null],
    ]);
  });

  it('turns distance from metres into km', () => {
    const [o] = originsOfSamples('distance', [s(2500, '2026-10-01T08:00:00Z', FIT)], dayOf);
    expect(o!.apps[0]!.value).toBe(2.5);
  });

  it('averages heart rate and finds the day extremes per app', () => {
    const hr = [
      s(60, '2026-10-01T08:00:00Z', FIT),
      s(100, '2026-10-01T09:00:00Z', FIT),
      s(80, '2026-10-01T09:00:00Z', FITNESS),
    ];
    const v = (m: string) => originsOfSamples(m, hr, dayOf)[0]!.apps.map((a) => a.value);
    expect(v('hr_avg')).toEqual([80, 80]);
    expect(v('hr_min').sort((a, b) => a - b)).toEqual([60, 80]);
    expect(v('hr_max').sort((a, b) => a - b)).toEqual([80, 100]);
  });

  it('takes the latest weight and the latest reading by end time', () => {
    const [o] = originsOfSamples(
      'weight',
      [s(81, '2026-10-01T07:00:00Z', FIT), s(80.5, '2026-10-01T19:00:00Z', FIT)],
      dayOf,
    );
    expect(o!.apps[0]).toMatchObject({ value: 80.5, records: 2 });
  });

  it('reads blood pressure parts, and blood sugar in mmol/L', () => {
    const bp = [
      s(0.001, '2026-10-01T08:00:00Z', FIT, { systolic: 120, diastolic: 80 }),
      s(0.001, '2026-10-01T20:00:00Z', FIT, { systolic: 130, diastolic: 90 }),
    ];
    expect(originsOfSamples('bp_systolic', bp, dayOf)[0]!.apps[0]!.value).toBe(125);
    expect(originsOfSamples('bp_diastolic', bp, dayOf)[0]!.apps[0]!.value).toBe(85);
    const [g] = originsOfSamples('blood_glucose', [s(90.08, '2026-10-01T08:00:00Z', FIT)], dayOf);
    expect(g!.apps[0]!.value).toBe(5);
  });

  it('drops values the record mappers drop', () => {
    expect(originsOfSamples('spo2', [s(150, '2026-10-01T08:00:00Z', FIT)], dayOf)).toEqual([]);
    expect(originsOfSamples('steps', [s(0, '2026-10-01T08:00:00Z', FIT)], dayOf)).toEqual([]);
    expect(originsOfSamples('food_energy', [s(25000, '2026-10-01T08:00:00Z', FIT)], dayOf)).toEqual(
      [],
    );
  });

  it('spreads total calories over the days a record covers', () => {
    const out = originsOfSamples(
      'total_calories',
      [s(2000, '2026-10-01T12:00:00Z', FIT, { endDate: '2026-10-02T12:00:00Z' })],
      dayOf,
    );
    expect(out.map((o) => o.date)).toEqual(['2026-10-01', '2026-10-02']);
    expect(out[0]!.apps[0]!.value).toBeCloseTo(1000, 0);
  });

  it('groups samples with no origin under "unknown"', () => {
    const [o] = originsOfSamples('steps', [s(5, '2026-10-01T08:00:00Z', undefined)], dayOf);
    expect(o!.apps[0]!.packageName).toBe('unknown');
  });

  it('only reports days in range', () => {
    const out = originsOfSamples(
      'steps',
      [s(5, '2026-09-30T08:00:00Z', FIT), s(5, '2026-10-01T08:00:00Z', FIT)],
      dayOf,
      { inRange: (d) => d >= '2026-10-01' },
    );
    expect(out.map((o) => o.date)).toEqual(['2026-10-01']);
  });
});

describe('sleep and workouts', () => {
  const night = (app: string, start: string, end: string) => ({
    startDate: start,
    endDate: end,
    sourceId: app,
    deviceType: 'watch',
  });

  it('gives each app its own hours asleep, combining that app’s night', () => {
    const out = sleepOrigins(
      [
        night(FIT, '2026-09-30T22:00:00Z', '2026-10-01T02:00:00Z'),
        night(FIT, '2026-10-01T03:00:00Z', '2026-10-01T06:00:00Z'),
        night(FITNESS, '2026-09-30T22:30:00Z', '2026-10-01T06:00:00Z'),
      ],
      dayOf,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ date: '2026-10-01', metric: 'sleep', counted: null });
    expect(out[0]!.apps).toEqual([
      { packageName: FITNESS, value: 7.5, records: 1, devices: ['watch'] },
      { packageName: FIT, value: 7, records: 2, devices: ['watch'] },
    ]);
  });

  it('counts workouts per app and day', () => {
    const out = workoutOrigins(
      [
        { startDate: '2026-10-01T07:00:00Z', sourceId: FIT },
        { startDate: '2026-10-01T18:00:00Z', sourceId: FIT },
        { startDate: '2026-10-01T18:05:00Z', sourceId: 'com.strava' },
      ],
      dayOf,
    );
    expect(out[0]!.apps).toEqual([
      { packageName: FIT, value: 2, records: 2, devices: [] },
      { packageName: 'com.strava', value: 1, records: 1, devices: [] },
    ]);
  });
});

describe('building every stat from one read', () => {
  it('uses the aggregates as counted, flags a read that hit its cap, and only emits known keys', () => {
    const many = Array.from({ length: readCapOf('steps') }, (_, i) =>
      s(1, '2026-10-01T08:00:00Z', FIT, { platformId: String(i) }),
    );
    const origins = buildOrigins({
      samples: new Map([
        ['steps', many],
        ['heartRate', [s(70, '2026-10-01T08:00:00Z', FIT)]],
        ['dietaryWater', [s(0.5, '2026-10-01T08:00:00Z', FIT)]],
        ['distance', [s(1000, '2026-10-01T08:00:00Z', FIT)]],
      ]),
      buckets: new Map([
        ['steps', [{ startDate: '2026-10-01T00:00:00Z', value: 4000 }]],
        ['distance', [{ startDate: '2026-10-01T00:00:00Z', value: 3200 }]],
        [
          'heartRate',
          [
            {
              startDate: '2026-10-01T00:00:00Z',
              value: 71,
              values: { min: 50, max: 150, average: 71 },
            },
          ],
        ],
        ['dietaryWater', [{ startDate: '2026-10-01T00:00:00Z', value: 1.25 }]],
      ]),
      sleep: null,
      workouts: [{ startDate: '2026-10-01T07:00:00Z', sourceId: FIT }],
      dayOf,
      days: { from: '2026-10-01', to: '2026-10-07' },
    });
    const by = (m: string) => origins.find((o) => o.metric === m)!;
    expect(by('steps')).toMatchObject({ counted: 4000, capped: true });
    expect(by('distance')).toMatchObject({ counted: 3.2, capped: false });
    expect(by('hr_avg').counted).toBe(71);
    expect(by('hr_min').counted).toBe(50);
    expect(by('hr_max').counted).toBe(150);
    expect(by('water')).toMatchObject({ counted: 1.25 });
    expect(by('workouts').apps[0]!.value).toBe(1);
    for (const o of origins) expect(HC_ORIGIN_METRICS).toContain(o.metric);
  });

  it('every stat the server accepts has a reader (except sleep and workouts)', () => {
    const readers = new Set([...Object.keys(ORIGIN_SPECS), 'sleep', 'workouts']);
    expect([...HC_ORIGIN_METRICS].sort()).toEqual([...readers].sort());
  });
});
