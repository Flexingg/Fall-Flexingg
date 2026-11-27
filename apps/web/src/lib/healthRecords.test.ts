import { HEALTH_INGEST_TYPES } from '@gauntlet/shared';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_GROUPS,
  accessRows,
  accessSummary,
  basalRecords,
  basalBodyTemperatureRecords,
  bodyFatRecords,
  bodyTemperatureRecords,
  floorsRecords,
  heightRecords,
  hrvRecords,
  mindfulnessRecords,
  respiratoryRateRecords,
  restingHeartRateRecords,
  vo2MaxRecords,
  bloodGlucoseRecords,
  bloodPressureRecords,
  FIRST_SYNC_DAYS,
  heartRateRecords,
  latestByDay,
  nutritionRecords,
  oxygenRecords,
  READ_TYPES,
  RESEND_DAYS,
  spreadByDay,
  syncDays,
  syncStart,
  totalCaloriesRecords,
  waterRecords,
  weightRecords,
  type Sample,
} from './healthRecords';

// UTC days keep the tests independent of the machine's time zone.
const day = (iso: string) => iso.slice(0, 10);
const s = (startDate: string, value: number, extra: Partial<Sample> = {}): Sample => ({
  startDate,
  endDate: extra.endDate ?? startDate,
  value,
  ...extra,
});

describe('permissions list', () => {
  it('asks for every Android health type once, with no Apple-only ones', () => {
    expect(new Set(READ_TYPES).size).toBe(READ_TYPES.length);
    for (const t of [
      'heartRate',
      'bloodPressure',
      'dietaryWater',
      'mindfulness',
      'workouts',
      'sleep',
    ])
      expect(READ_TYPES).toContain(t);
    for (const t of ['appleStandHour', 'appleSleepingWristTemperature', 'exerciseTime'])
      expect(READ_TYPES).not.toContain(t);
  });

  it('groups them in plain words', () => {
    expect(ACCESS_GROUPS.map((g) => g.title)).toEqual([
      'Activity',
      'Body',
      'Heart and vitals',
      'Sleep',
      'Nutrition',
      'Mind',
    ]);
  });

  it('marks what is allowed', () => {
    const rows = accessRows(['steps', 'sleep']).flatMap((g) => g.rows);
    expect(rows.find((r) => r.type === 'steps')!.allowed).toBe(true);
    expect(rows.find((r) => r.type === 'weight')!.allowed).toBe(false);
    expect(accessSummary(['steps', 'sleep', 'unknown'])).toEqual({
      allowed: 2,
      total: READ_TYPES.length,
    });
  });
});

describe('sync window', () => {
  it('re-sends the last 7 days after the first sync, and 30 on the first', () => {
    expect(syncDays(true)).toBe(RESEND_DAYS);
    expect(RESEND_DAYS).toBe(7);
    expect(syncDays(false)).toBe(FIRST_SYNC_DAYS);
    expect(FIRST_SYNC_DAYS).toBe(30);
    expect(syncDays(true, 3)).toBe(3);
  });

  it('starts at local midnight that many days back, so today is included', () => {
    const now = new Date(2026, 4, 20, 15, 30);
    const start = syncStart(now, 7);
    expect([start.getFullYear(), start.getMonth(), start.getDate()]).toEqual([2026, 4, 13]);
    expect([start.getHours(), start.getMinutes()]).toEqual([0, 0]);
  });
});

describe('daily records', () => {
  it('splits energy recorded across midnight by time in each day', () => {
    const m = spreadByDay(
      [s('2026-05-19T22:00:00Z', 100, { endDate: '2026-05-20T02:00:00Z' })],
      day,
    );
    expect(m.get('2026-05-19')).toBeCloseTo(50, 5);
    expect(m.get('2026-05-20')).toBeCloseTo(50, 5);
  });

  it("sums total calories per day under SparkyFitness' name", () => {
    const r = totalCaloriesRecords(
      [
        s('2026-05-20T08:00:00Z', 300, { endDate: '2026-05-20T08:10:00Z' }),
        s('2026-05-20T09:00:00Z', 250.456, { endDate: '2026-05-20T09:10:00Z' }),
      ],
      day,
    );
    expect(r).toEqual([
      {
        type: 'TotalCaloriesBurned',
        value: 550.46,
        date: '2026-05-20',
        unit: 'kcal',
        source: 'Health Connect',
      },
    ]);
  });

  it('keeps the latest weight of each day, one record per day', () => {
    const r = weightRecords(
      [
        s('2026-05-20T07:00:00Z', 80),
        s('2026-05-20T21:00:00Z', 79.5),
        s('2026-05-19T07:00:00Z', 81),
      ],
      day,
    );
    expect(r.map((x) => [x.date, x.value]).sort()).toEqual([
      ['2026-05-19', 81],
      ['2026-05-20', 79.5],
    ]);
    expect(r.every((x) => x.type === 'weight' && x.unit === 'kg')).toBe(true);
  });

  it('latestByDay ignores empty and negative readings', () => {
    expect(
      latestByDay([s('2026-05-20T07:00:00Z', 0), s('2026-05-20T08:00:00Z', -2)], day).size,
    ).toBe(0);
  });

  it('turns blood pressure into a systolic and a diastolic average', () => {
    const r = bloodPressureRecords(
      [
        s('2026-05-20T07:00:00Z', 120, { systolic: 120, diastolic: 80 }),
        s('2026-05-20T19:00:00Z', 130, { systolic: 130, diastolic: 90 }),
      ],
      day,
    );
    expect(r.map((x) => [x.type, x.value])).toEqual([
      ['blood_pressure_systolic', 125],
      ['blood_pressure_diastolic', 85],
    ]);
  });

  it('converts blood sugar to mmol/L and caps blood oxygen at 100', () => {
    const [g] = bloodGlucoseRecords([s('2026-05-20T07:00:00Z', 90.08)], day);
    expect(g).toMatchObject({ type: 'blood_glucose', unit: 'mmol/L', value: 5 });
    expect(oxygenRecords([s('2026-05-20T07:00:00Z', 140)], day)).toEqual([]);
  });

  it('only sends resting calories that look like a daily rate', () => {
    const r = basalRecords([s('2026-05-20T00:00:00Z', 1750), s('2026-05-19T00:00:00Z', 12)], day);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ type: 'BasalMetabolicRate', value: 1750 });
  });
});

describe('aggregated and keyed records', () => {
  it('sends heart rate as min, max and average', () => {
    const r = heartRateRecords(
      [
        {
          startDate: '2026-05-20T00:00:00Z',
          value: 70,
          values: { min: 48, max: 160, average: 70.123 },
        },
      ],
      day,
    );
    expect(r.map((x) => [x.type, x.value])).toEqual([
      ['heart_rate_min', 48],
      ['heart_rate_max', 160],
      ['heart_rate_avg', 70.12],
    ]);
  });

  it('sends water in millilitres with the same id every time', () => {
    const b = [{ startDate: '2026-05-20T00:00:00Z', value: 1.75 }];
    const a = waterRecords(b, day);
    expect(a).toEqual(waterRecords(b, day));
    expect(a[0]).toMatchObject({
      type: 'water',
      value: 1750,
      unit: 'ml',
      source_id: 'gauntlet-water-2026-05-20',
    });
  });

  it("sends food energy as a day's total, not as diary entries", () => {
    const r = nutritionRecords(
      [
        s('2026-05-20T12:00:00Z', 640, { platformId: 'abc' }),
        s('2026-05-20T18:00:00Z', 560),
        s('2026-05-20T13:00:00Z', 0),
      ],
      day,
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      type: 'dietary_energy',
      value: 1200,
      unit: 'kcal',
      date: '2026-05-20',
    });
  });
});

describe('what the API accepts', () => {
  it('lists every type the mappers can produce', () => {
    const at = '2026-05-20T08:00:00Z';
    const one = [s(at, 100, { systolic: 120, diastolic: 80 })];
    const bucket = [{ startDate: at, value: 5, values: { min: 1, max: 9, average: 5 } }];
    const made = [
      ...totalCaloriesRecords(one, day),
      ...basalRecords([s(at, 1800)], day),
      ...weightRecords(one, day),
      ...bodyFatRecords(one, day),
      ...heightRecords(one, day),
      ...waterRecords(bucket, day),
      ...nutritionRecords(one, day),
      ...heartRateRecords(bucket, day),
      ...restingHeartRateRecords(bucket, day),
      ...hrvRecords(one, day),
      ...respiratoryRateRecords(one, day),
      ...oxygenRecords(one, day),
      ...vo2MaxRecords(one, day),
      ...bloodPressureRecords(one, day),
      ...bloodGlucoseRecords(one, day),
      ...bodyTemperatureRecords(one, day),
      ...basalBodyTemperatureRecords(one, day),
      ...floorsRecords(one, day),
      ...mindfulnessRecords(one, day),
    ];
    expect(new Set(made.map((r) => r.type)).size).toBe(made.length);
    for (const r of made) expect(HEALTH_INGEST_TYPES).toContain(r.type);
  });
});
