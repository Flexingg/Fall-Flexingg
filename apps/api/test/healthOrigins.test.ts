import type { HcOrigin } from '@gauntlet/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { healthOrigins } from '../src/db/schema.js';
import { refreshDemo, findDemoUser } from '../src/services/demo.js';
import { originFor } from '../src/services/healthOrigins.js';
import { setup, type Harness } from './notifyHarness.js';

let h: Harness;
const URL = '/api/ingest/health-connect/origins';
const origin = (over: Partial<HcOrigin> = {}): HcOrigin => ({
  date: '2026-10-01',
  metric: 'steps',
  apps: [
    { packageName: 'com.fitbit.FitbitMobile', value: 8000, records: 40, devices: ['watch'] },
    { packageName: 'com.google.android.apps.fitness', value: 7900, records: 12, devices: [] },
  ],
  counted: 8100,
  capped: false,
  ...over,
});
const rowsOf = (who: string) =>
  h.ctx.db.select().from(healthOrigins).where(eq(healthOrigins.userId, h.ids[who]!));

beforeAll(async () => {
  h = await setup(['ann', 'ben']);
});
afterAll(async () => h.close());

describe('health connect origins', () => {
  it('requires sign-in', async () => {
    expect((await h.raw(null, 'POST', URL, { origins: [origin()] })).statusCode).toBe(401);
  });

  it('stores origins and returns them through originFor', async () => {
    const res = await h.raw('ann', 'POST', URL, {
      origins: [origin(), origin({ metric: 'sleep', counted: null, apps: [] })],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stored: 2 });
    const row = await originFor(h.ctx, h.ids.ann!, '2026-10-01', 'steps');
    expect(row).toMatchObject({ counted: 8100, capped: false });
    expect(row!.apps).toHaveLength(2);
    expect(row!.apps[0]).toMatchObject({ packageName: 'com.fitbit.FitbitMobile', value: 8000 });
    expect(await originFor(h.ctx, h.ids.ann!, '2026-10-02', 'steps')).toBeNull();
  });

  it('replaces a day and stat when it is sent again', async () => {
    const next = origin({
      apps: [{ packageName: 'com.strava', value: 9000, records: 1, devices: ['phone'] }],
      counted: null,
      capped: true,
    });
    // A pair sent twice in one request: the last one wins.
    const res = await h.raw('ann', 'POST', URL, { origins: [origin(), next] });
    expect(res.statusCode).toBe(200);
    const row = await originFor(h.ctx, h.ids.ann!, '2026-10-01', 'steps');
    expect(row!.apps.map((a) => a.packageName)).toEqual(['com.strava']);
    expect(row).toMatchObject({ counted: null, capped: true });
    expect((await rowsOf('ann')).length).toBe(2);
  });

  it('rejects bad bodies and stores nothing from them', async () => {
    const bad = async (origins: unknown) =>
      (await h.raw('ann', 'POST', URL, { origins })).statusCode;
    expect(await bad([])).toBe(400);
    expect(await bad([origin({ metric: 'nonsense' })])).toBe(400);
    expect(await bad([origin({ date: '2026-13-45' })])).toBe(400);
    expect(await bad([origin({ date: '10/01/2026' })])).toBe(400);
    expect(await bad([origin({ date: '2020-01-01' })])).toBe(400);
    expect(await bad([origin({ date: '2026-10-20' })])).toBe(400);
    expect(await bad([{ ...origin(), apps: [{ packageName: 'x' }] }])).toBe(400);
    // One bad entry sinks the whole batch.
    expect(await bad([origin({ metric: 'hrv' }), origin({ metric: 'nonsense' })])).toBe(400);
    expect(await originFor(h.ctx, h.ids.ann!, '2026-10-01', 'hrv')).toBeNull();
    expect((await h.raw('ann', 'POST', URL, {})).statusCode).toBe(400);
  });

  it('accepts today, tomorrow, and the health metric keys', async () => {
    const ok = await h.raw('ann', 'POST', URL, {
      origins: [
        origin({ date: '2026-10-02', metric: 'hr_avg' }),
        origin({ date: '2026-10-03', metric: 'blood_glucose' }),
      ],
    });
    expect(ok.statusCode).toBe(200);
  });

  it("keeps one person's origins away from another's", async () => {
    await h.call('ben', 'POST', URL, {
      origins: [
        origin({
          apps: [{ packageName: 'com.ouraring.oura', value: 5, records: 1, devices: [] }],
        }),
      ],
    });
    expect((await originFor(h.ctx, h.ids.ann!, '2026-10-01', 'steps'))!.apps[0]!.packageName).toBe(
      'com.strava',
    );
    expect((await originFor(h.ctx, h.ids.ben!, '2026-10-01', 'steps'))!.apps[0]!.packageName).toBe(
      'com.ouraring.oura',
    );
  });

  it('is blocked for the demo account', async () => {
    await refreshDemo(h.ctx);
    h.ids.demo = (await findDemoUser(h.ctx))!.id;
    const res = await h.raw('demo', 'POST', URL, { origins: [origin()] });
    expect(res.statusCode).toBe(403);
    expect(await originFor(h.ctx, h.ids.demo, '2026-10-01', 'steps')).toBeNull();
  });

  it('goes with the account when it is deleted', async () => {
    expect((await h.raw('ben', 'DELETE', '/api/me')).statusCode).toBe(200);
    const left = await h.ctx.db
      .select()
      .from(healthOrigins)
      .where(and(eq(healthOrigins.userId, h.ids.ben!)));
    expect(left).toHaveLength(0);
    expect((await rowsOf('ann')).length).toBeGreaterThan(0);
  });
});
