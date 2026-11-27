/**
 * Which Health Connect apps count: the apps seen in the last 30 days (with the phone's own names
 * when it sent them), saving an order (cleaned up), bad input, and never anyone else's data.
 */
import type { HcAppsResponse, StatSourceResponse } from '@gauntlet/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { healthOrigins, users } from '../src/db/schema.js';
import { setup, type Harness } from './notifyHarness.js';

let h: Harness;
const id = (n: string) => h.ids[n]!;
const get = (who: string | null) => h.raw(who, 'GET', '/api/me/hc-apps');
const put = (who: string | null, payload: unknown) => h.raw(who, 'PUT', '/api/me/hc-apps', payload);
const ok = async (r: Awaited<ReturnType<typeof get>>) => {
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as HcAppsResponse;
};

const FIT = 'com.fitbit.FitbitMobile';
const GAR = 'com.garmin.android.apps.connectmobile';
const PHONE = 'com.android.healthconnect.phone.abc123';

beforeAll(async () => {
  h = await setup(['ann', 'ben'], { clock: '2026-10-02T18:00:00Z', timezone: 'UTC' });
  const row = (
    userId: string,
    date: string,
    metric: string,
    apps: { packageName: string; name?: string; value: number; devices?: string[] }[],
  ) => ({
    userId,
    date,
    metric,
    apps: apps.map((a) => ({ records: a.value > 0 ? 3 : 0, devices: [], ...a })),
    counted: null,
    capped: false,
  });
  await h.ctx.db.insert(healthOrigins).values([
    row(id('ann'), '2026-10-02', 'steps', [
      { packageName: FIT, value: 4000, devices: ['watch'] },
      { packageName: GAR, name: 'Garmin Connect', value: 3000, devices: ['watch'] },
      { packageName: PHONE, name: 'Phone', value: 2000, devices: ['phone'] },
    ]),
    row(id('ann'), '2026-10-01', 'steps', [
      { packageName: FIT, value: 3500, devices: ['watch', 'phone'] },
      { packageName: GAR, name: 'Garmin', value: 3000 },
    ]),
    row(id('ann'), '2026-09-30', 'steps', [{ packageName: PHONE, value: 0 }]), // wrote nothing
    row(id('ann'), '2026-08-01', 'steps', [{ packageName: 'com.strava', value: 10 }]), // too old
    row(id('ann'), '2026-10-02', 'sleep', [{ packageName: 'com.ouraring.oura', value: 7.5 }]),
    row(id('ben'), '2026-10-02', 'steps', [{ packageName: 'com.whoop.android', value: 99 }]),
  ]);
});
afterAll(() => h.close());

describe('GET /api/me/hc-apps', () => {
  it('lists the apps seen per stat, most days first, with the latest name', async () => {
    const r = await ok(await get('ann'));
    expect(r.order).toEqual({});
    expect(r.seen.steps).toEqual([
      { packageName: FIT, name: 'Fitbit', days: 2, devices: ['watch', 'phone'] },
      { packageName: GAR, name: 'Garmin Connect', days: 2, devices: ['watch'] },
      { packageName: PHONE, name: 'This phone', days: 1, devices: ['phone'] },
    ]);
    // A friendly name is filled in when the phone sent none; a day with no data doesn't count.
    expect(r.seen.sleep).toEqual([
      { packageName: 'com.ouraring.oura', name: 'Oura', days: 1, devices: [] },
    ]);
  });

  it('needs a signed-in person', async () => {
    expect((await get(null)).statusCode).toBe(401);
  });
});

describe('the where-from sheet', () => {
  it("shows the phone's own app name, and a friendly one when it sent none", async () => {
    const r = await h.raw('ann', 'GET', '/api/me/day/stat?date=2026-10-02&metric=steps');
    const apps = (r.json() as StatSourceResponse).phone!.apps;
    expect(apps.map((a) => [a.packageName, a.name])).toEqual([
      [FIT, 'Fitbit'],
      [GAR, 'Garmin Connect'],
      [PHONE, 'This phone'],
    ]);
  });
});

describe('PUT /api/me/hc-apps', () => {
  it('saves the order, dropping repeats and empty lists, and returns it', async () => {
    const r = await ok(await put('ann', { order: { steps: [GAR, FIT, GAR], sleep: [] } }));
    expect(r.order).toEqual({ steps: [GAR, FIT] });
    expect(r.seen.steps).toHaveLength(3);
    expect((await ok(await get('ann'))).order).toEqual({ steps: [GAR, FIT] });
    const [u] = await h.ctx.db
      .select()
      .from(users)
      .where(eq(users.id, id('ann')));
    expect(u!.hcAppOrder).toEqual({ steps: [GAR, FIT] });
  });

  it('replaces the whole order, and an empty one goes back to Health Connect', async () => {
    await ok(await put('ann', { order: { steps: [FIT], distance: [GAR] } }));
    expect((await ok(await get('ann'))).order).toEqual({ steps: [FIT], distance: [GAR] });
    expect((await ok(await put('ann', { order: {} }))).order).toEqual({});
  });

  it('refuses a stat nobody reads, long lists and bad shapes', async () => {
    for (const payload of [
      { order: { nothing: [FIT] } },
      { order: { steps: Array.from({ length: 11 }, (_, i) => `com.app${i}`) } },
      { order: { steps: [''] } },
      { order: { steps: 'x' } },
      { order: [] },
      {},
    ])
      expect((await put('ann', payload)).statusCode, JSON.stringify(payload)).toBe(400);
    expect((await put(null, { order: {} })).statusCode).toBe(401);
  });

  it("keeps people apart: one person's choice and apps never reach another", async () => {
    await ok(await put('ann', { order: { steps: [GAR] } }));
    const ben = await ok(await get('ben'));
    expect(ben.order).toEqual({});
    expect(ben.seen.steps!.map((a) => a.packageName)).toEqual(['com.whoop.android']);
    expect(ben.seen.sleep).toBeUndefined();
    await ok(await put('ben', { order: { steps: ['com.whoop.android'] } }));
    expect((await ok(await get('ann'))).order).toEqual({ steps: [GAR] });
  });
});
