import type { SourcePriorityResponse, StatSourceResponse } from '@gauntlet/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dailyMetrics } from '../src/db/schema.js';
import { syncUser } from '../src/services/sync.js';
import { setup, type Harness } from './notifyHarness.js';

let h: Harness;
const DAY = '2026-10-02';
const OZ = 29.5735;

const stored = async (metric: string, date = DAY) =>
  (
    await h.ctx.db
      .select()
      .from(dailyMetrics)
      .where(
        and(
          eq(dailyMetrics.userId, h.ids.ann!),
          eq(dailyMetrics.date, date),
          eq(dailyMetrics.metric, metric),
        ),
      )
  )[0];

beforeAll(async () => {
  h = await setup(['ann'], { clock: '2026-10-02T18:00:00Z', timezone: 'UTC' });
  const ann = h.sparky.ann!;
  ann.goals.push({ from: '2026-01-01', goals: { water_goal_ml: 3000 } });
  // 80 oz logged in SparkyFitness, and the same 80 oz written to Health Connect by another app.
  ann.water.push(
    { entry_date: DAY, water_ml: 80 * OZ, source: 'manual' },
    { entry_date: DAY, water_ml: 80 * OZ, source: 'Health Connect' },
  );
});
afterAll(() => h.close());

describe('water from two sources', () => {
  it('counts the day once, not twice', async () => {
    await syncUser(h.ctx, h.ids.ann!);
    const w = await stored('water');
    expect(w!.value).toBeCloseTo((80 * OZ) / 1000, 2);
    expect(w!.detail!.candidates.map((c) => c.source).sort()).toEqual(['Health Connect', 'manual']);
    // The goal percentage follows the value that counted (2.37 L of 3 L), not both added up.
    expect((await stored('water_goal'))!.value).toBeCloseTo(78.9, 0);
  });

  it('offers both sources on the long-press sheet', async () => {
    const r = (await h.call(
      'ann',
      'GET',
      `/api/me/day/stat?date=${DAY}&metric=water`,
    )) as StatSourceResponse;
    expect(r.candidates.map((c) => c.sourceKey).sort()).toEqual([
      'health_connect',
      'sparkyfitness',
    ]);
    expect(r.candidates.filter((c) => c.chosen)).toHaveLength(1);
  });

  it('lists water under "Which source counts" and obeys the choice', async () => {
    const before = await h.call<SourcePriorityResponse>('ann', 'GET', '/api/me/source-priority');
    const water = before.metrics.find((m) => m.key === 'water')!;
    expect(water.label).toBe('Water');
    expect(water.sources.map((s) => s.key)).toContain('sparkyfitness');
    expect(water.sources.map((s) => s.key)).toContain('health_connect');
    // Another day where the phone's number is bigger, then prefer SparkyFitness for water.
    h.sparky.ann!.water.push(
      { entry_date: '2026-10-01', water_ml: 500, source: 'manual' },
      { entry_date: '2026-10-01', water_ml: 1500, source: 'Health Connect' },
    );
    await syncUser(h.ctx, h.ids.ann!);
    expect((await stored('water', '2026-10-01'))!.value).toBe(1.5);
    await h.call('ann', 'PUT', '/api/me/source-priority', {
      metric: 'water',
      order: ['sparkyfitness'],
    });
    await syncUser(h.ctx, h.ids.ann!);
    expect(await stored('water', '2026-10-01')).toMatchObject({ value: 0.5, source: 'manual' });
  });

  it('does not look settled days up again once their split is stored', async () => {
    h.fake.calls.length = 0;
    await syncUser(h.ctx, h.ids.ann!);
    // Both days are within two days of "today" in this test, so they are looked up; move on a week.
    h.setClock('2026-10-12T18:00:00Z');
    h.fake.calls.length = 0;
    await syncUser(h.ctx, h.ids.ann!);
    expect(h.fake.calls.filter((c) => c.includes('/measurements/water-intake/'))).toHaveLength(0);
    expect((await stored('water', '2026-10-01'))!.value).toBe(0.5);
  });
});
