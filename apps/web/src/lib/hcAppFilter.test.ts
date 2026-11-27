import type { HcOrigin } from '@gauntlet/shared';
import { describe, expect, it, vi } from 'vitest';
import { nameOrigins, withAppNames } from './appLabels';
import {
  activeOrder,
  APP_RECORDS,
  dayWindows,
  filteredSampleTypes,
  keepChosenApp,
  readInWindows,
  recordsFromOrigins,
  replacedRecordTypes,
} from './hcAppFilter';
import { ORIGIN_SPECS } from './hcOriginsRead';
import { combineSleep } from './sleepSessions';

const FIT = 'com.fitbit.FitbitMobile';
const PHONE = 'com.android.healthconnect.phone.abc';
const RING = 'com.randallengineering.sleepasringconn';
const SAA = 'com.urbandroid.sleep';
const app = (packageName: string, value: number) => ({
  packageName,
  value,
  records: 1,
  devices: [],
});
const origin = (metric: string, date: string, apps: ReturnType<typeof app>[]): HcOrigin => ({
  date,
  metric,
  apps,
  counted: null,
  capped: false,
});
const midnight = (d: string) => `${d}T00:00:00.000Z`;

describe('which stats have a filter', () => {
  it('ignores empty lists and stats nobody reads', () => {
    expect(activeOrder({ steps: [FIT], distance: [], nonsense: [FIT] })).toEqual({ steps: [FIT] });
    expect(activeOrder(null)).toEqual({});
  });
  it('finds the Health Connect types to read a day at a time and the records to replace', () => {
    const order = { steps: [FIT], hr_min: [FIT], hr_max: [FIT], sleep: [SAA] };
    expect([...filteredSampleTypes(order)].sort()).toEqual(['heartRate', 'steps']);
    expect([...replacedRecordTypes(order)].sort()).toEqual([
      'heart_rate_max',
      'heart_rate_min',
      'step',
    ]);
  });
  it('knows a record for every stat the origins can report (but sleep and workouts)', () => {
    expect(Object.keys(APP_RECORDS).sort()).toEqual(Object.keys(ORIGIN_SPECS).sort());
  });
});

describe('records from the chosen app', () => {
  it('uses the first listed app that has data that day, alone', () => {
    const recs = recordsFromOrigins(
      { steps: [FIT, PHONE] },
      [
        origin('steps', '2026-11-25', [app(PHONE, 9000), app(FIT, 4000)]),
        origin('steps', '2026-11-26', [app(PHONE, 7000)]),
      ],
      midnight,
    );
    expect(recs).toEqual([
      { type: 'step', value: 4000, date: '2026-11-25', unit: 'count', source: 'Health Connect' },
      { type: 'step', value: 7000, date: '2026-11-26', unit: 'count', source: 'Health Connect' },
    ]);
  });
  it('sends nothing for a day none of the listed apps covers, or an unlisted stat', () => {
    const recs = recordsFromOrigins(
      { steps: [FIT] },
      [
        origin('steps', '2026-11-25', [app(PHONE, 9000)]),
        origin('distance', '2026-11-25', [app(PHONE, 5)]),
      ],
      midnight,
    );
    expect(recs).toEqual([]);
  });
  it('converts stored units back: km to metres, litres to millilitres with a stable id', () => {
    const recs = recordsFromOrigins(
      { distance: [FIT], water: [FIT] },
      [
        origin('distance', '2026-11-25', [app(FIT, 5.1234)]),
        origin('water', '2026-11-25', [app(FIT, 1.5)]),
      ],
      midnight,
    );
    expect(recs[0]).toMatchObject({ type: 'distance', value: 5123.4, unit: 'm' });
    expect(recs[1]).toMatchObject({
      type: 'water',
      value: 1500,
      unit: 'ml',
      source_id: 'gauntlet-water-2026-11-25',
      timestamp: '2026-11-25T00:00:00.000Z',
    });
  });
});

describe('sleep and workouts of the chosen app', () => {
  const day = (iso: string) => iso.slice(0, 10);
  const sess = (start: string, end: string, sourceId: string) => ({
    startDate: `${start}Z`,
    endDate: `${end}Z`,
    sourceId,
  });
  it('keeps only the first listed app that slept that night', () => {
    const sessions = [
      sess('2026-11-25T23:00:00', '2026-11-26T07:00:00', RING),
      sess('2026-11-26T03:00:00', '2026-11-26T03:36:00', SAA),
      sess('2026-11-26T23:00:00', '2026-11-27T05:00:00', SAA),
    ];
    const kept = keepChosenApp(
      sessions,
      [SAA, RING],
      (x) => day(x.endDate),
      (x) => x.sourceId,
    );
    expect(kept.map((x) => x.sourceId)).toEqual([SAA, SAA]);
    const nights = combineSleep(kept, day);
    expect(nights.map((n) => [n.date, n.asleepSeconds / 3600])).toEqual([
      ['2026-11-26', 0.6],
      ['2026-11-27', 6],
    ]);
  });
  it('drops a night the listed apps did not record, and does nothing without a list', () => {
    const sessions = [sess('2026-11-25T23:00:00', '2026-11-26T07:00:00', RING)];
    const d = (x: { endDate: string }) => day(x.endDate);
    const a = (x: { sourceId: string }) => x.sourceId;
    expect(keepChosenApp(sessions, [SAA], d, a)).toEqual([]);
    expect(keepChosenApp(sessions, [], d, a)).toEqual(sessions);
    expect(keepChosenApp(sessions, undefined, d, a)).toEqual(sessions);
  });
});

describe('reading a stat a day at a time', () => {
  it('cuts a range at local midnights', () => {
    const start = new Date(2026, 10, 25, 0, 0).toISOString();
    const end = new Date(2026, 10, 27, 15, 30).toISOString();
    const w = dayWindows(start, end);
    expect(w).toHaveLength(3);
    expect(w[0]!.startDate).toBe(start);
    expect(w[0]!.endDate).toBe(new Date(2026, 10, 26, 0, 0).toISOString());
    expect(w[2]!.endDate).toBe(end);
  });
  it('splits a window that comes back full, without losing or doubling samples', async () => {
    const t0 = Date.parse('2026-11-25T00:00:00Z');
    const all = Array.from({ length: 40 }, (_, i) => {
      const at = new Date(t0 + i * 36 * 60_000).toISOString();
      return { value: 1, startDate: at, endDate: at, platformId: `id${i}` };
    });
    // The plugin: the newest `limit` samples inside the window.
    const read = vi.fn(async (w: { startDate: string; endDate: string }) =>
      all.filter((s) => s.startDate >= w.startDate && s.startDate < w.endDate).slice(-10),
    );
    const got = await readInWindows(
      read,
      [{ startDate: new Date(t0).toISOString(), endDate: new Date(t0 + 86_400_000).toISOString() }],
      10,
    );
    expect(got).toHaveLength(40);
    expect(read.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('app names', () => {
  it('fills the name Android gave, leaving unknown apps alone', () => {
    const [o] = withAppNames([origin('steps', '2026-11-25', [app(SAA, 1), app(FIT, 2)])], {
      [SAA]: 'Sleep as Android',
    });
    expect(o!.apps.map((a) => a.name)).toEqual(['Sleep as Android', undefined]);
  });
  it('never throws, off the phone', async () => {
    const list = [origin('steps', '2026-11-25', [app(FIT, 2)])];
    await expect(nameOrigins(list)).resolves.toEqual(list);
  });
});
