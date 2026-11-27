/**
 * The "where did this come from" sheet's endpoint: the stored value with the candidates the merge
 * chose between, the Health Connect apps the phone reported, an old value without detail, nothing
 * recorded, bad parameters, and never anyone else's data.
 */
import type { StatSourceResponse } from '@gauntlet/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dailyMetrics, healthOrigins } from '../src/db/schema.js';
import { setup, type Harness } from './notifyHarness.js';

let h: Harness;
const id = (n: string) => h.ids[n]!;
const get = (who: string, qs: string) => h.raw(who, 'GET', `/api/me/day/stat?${qs}`);
const ok = async (who: string, qs: string) => {
  const r = await get(who, qs);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as StatSourceResponse;
};
const DAY = '2026-10-02';

beforeAll(async () => {
  h = await setup(['ann', 'ben'], { clock: '2026-10-02T18:00:00Z', timezone: 'UTC' });
  await h.ctx.db.insert(dailyMetrics).values([
    {
      userId: id('ann'),
      date: DAY,
      metric: 'steps',
      value: 11_200,
      source: 'garmin',
      detail: {
        rule: 'highest',
        candidates: [
          { source: 'garmin', value: 11_200 },
          { source: 'Health Connect', value: 9_400 },
          { source: 'check-in', value: 9_000 },
        ],
      },
    },
    {
      userId: id('ann'),
      date: DAY,
      metric: 'sleep',
      value: 7.5,
      source: 'oura',
      detail: {
        rule: 'priority',
        order: 'metric',
        candidates: [
          { source: 'oura', value: 7.5 },
          { source: 'garmin', value: 7.1 },
        ],
      },
    },
    // Stored before 0.17: no detail.
    { userId: id('ann'), date: DAY, metric: 'distance', value: 8.2, source: 'garmin' },
    { userId: id('ben'), date: DAY, metric: 'steps', value: 999, source: 'fitbit' },
  ]);
  await h.ctx.db.insert(healthOrigins).values([
    {
      userId: id('ann'),
      date: DAY,
      metric: 'steps',
      apps: [
        {
          packageName: 'com.sec.android.app.shealth',
          value: 3000,
          records: 40,
          devices: ['phone'],
        },
        { packageName: 'com.fitbit.FitbitMobile', value: 9400, records: 120, devices: ['watch'] },
        { packageName: 'com.example.unknown', value: 0, records: 0, devices: [] },
      ],
      counted: 9400,
      capped: true,
    },
    {
      userId: id('ann'),
      date: DAY,
      metric: 'sleep',
      apps: [{ packageName: 'com.ouraring.oura', value: 7.5, records: 3, devices: ['ring'] }],
      counted: 7.5,
      capped: false,
    },
    {
      userId: id('ben'),
      date: DAY,
      metric: 'steps',
      apps: [{ packageName: 'com.strava', value: 1, records: 1, devices: [] }],
      counted: 1,
      capped: false,
    },
  ]);
});
afterAll(() => h.close());

describe('GET /api/me/day/stat', () => {
  it('shows the value, why it counts, every source and the phone apps', async () => {
    const r = await ok('ann', `date=${DAY}&metric=steps`);
    expect(r).toMatchObject({
      date: DAY,
      metric: 'steps',
      label: 'Steps',
      value: 11_200,
      source: { key: 'garmin', label: 'Garmin' },
      rule: 'highest',
      overlap: true,
    });
    expect(r.candidates.map((c) => [c.sourceKey, c.value, c.chosen])).toEqual([
      ['garmin', 11_200, true],
      ['health_connect', 9_400, false],
    ]);
    // "Health Connect" and "check-in" fold into one source, which keeps its highest value.
    expect(r.phone!.apps.map((a) => [a.name, a.value, a.records, a.devices])).toEqual([
      ['Fitbit', 9400, 120, ['watch']],
      ['Samsung Health', 3000, 40, ['phone']],
      ['com.example.unknown', 0, 0, []],
    ]);
    expect(r.phone).toMatchObject({ counted: 9400, capped: true });
    expect(r.updatedAt).toBeTruthy();
  });

  it('says whose source order it was, and one app is not an overlap', async () => {
    const r = await ok('ann', `date=${DAY}&metric=sleep`);
    expect(r).toMatchObject({ rule: 'priority', order: 'metric', source: { key: 'oura' } });
    expect(r.overlap).toBe(false);
    expect(r.phone!.apps).toHaveLength(1);
  });

  it('copes with a value stored before the detail existed', async () => {
    const r = await ok('ann', `date=${DAY}&metric=distance`);
    expect(r).toMatchObject({
      value: 8.2,
      source: { key: 'garmin', label: 'Garmin' },
      rule: null,
      candidates: [],
      phone: null,
      overlap: false,
      unit: 'km',
    });
  });

  it('answers with nothing when there is no value', async () => {
    const r = await ok('ann', `date=2026-10-01&metric=steps`);
    expect(r).toMatchObject({
      value: null,
      source: null,
      rule: null,
      candidates: [],
      phone: null,
      updatedAt: null,
    });
  });

  it('knows health metrics and custom ones', async () => {
    expect((await ok('ann', `date=${DAY}&metric=hrv`)).label).toBe('Heart rate variability');
    expect((await ok('ann', `date=${DAY}&metric=custom:mood`)).metric).toBe('custom:mood');
  });

  it('refuses bad parameters', async () => {
    for (const qs of [
      '',
      `date=${DAY}`,
      `metric=steps`,
      `date=nope&metric=steps`,
      `date=2026-10-03&metric=steps`, // tomorrow
      `date=2026-02-01&metric=steps`, // past the day screen's history
      `date=${DAY}&metric=nothing`,
      `date=${DAY}&metric=goal_calories`,
    ])
      expect((await get('ann', qs)).statusCode, qs).toBe(400);
    expect((await h.raw(null, 'GET', `/api/me/day/stat?date=${DAY}&metric=steps`)).statusCode).toBe(
      401,
    );
  });

  it("never shows another person's data", async () => {
    const ben = await ok('ben', `date=${DAY}&metric=steps`);
    expect(ben.value).toBe(999);
    expect(ben.phone!.apps.map((a) => a.name)).toEqual(['Strava']);
    // There is no way to ask for someone else's: a userId in the query changes nothing.
    const sneaky = await ok('ben', `date=${DAY}&metric=sleep&userId=${id('ann')}`);
    expect(sneaky).toMatchObject({ value: null, phone: null, candidates: [] });
  });
});
