/**
 * Configurable Today rings, the day-stats screen and the badge summary: the saved setup is
 * validated and per person, Today and the day screen read it, the day screen only ever shows the
 * signed-in person's own numbers, and the badge summary is cheap and correct.
 */
import type { BadgeSummary, DayResponse, RingConfig, TodayResponse } from '@gauntlet/shared';
import { DEFAULT_RINGS } from '@gauntlet/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dailyMetrics, userBadges, users } from '../src/db/schema.js';
import { demoRouteBlocked } from '../src/auth.js';
import { seedBadges } from '../src/services/badges/seed.js';
import { setup, type Harness } from './notifyHarness.js';

let h: Harness;
const id = (n: string) => h.ids[n]!;

beforeAll(async () => {
  h = await setup(['ann', 'ben'], { clock: '2026-10-02T18:00:00Z', timezone: 'UTC' });
  const put = (u: string, date: string, metric: string, value: number) =>
    h.ctx.db.insert(dailyMetrics).values({ userId: id(u), date, metric, value });
  await put('ann', '2026-10-02', 'steps', 6000);
  await put('ann', '2026-10-02', 'distance', 4.5);
  await put('ann', '2026-10-02', 'sleep', 7.5);
  await put('ann', '2026-10-02', 'calories_in', 1800);
  await put('ann', '2026-10-02', 'goal_calories', 2200);
  await put('ann', '2026-10-02', 'weight', 81.3);
  await put('ann', '2026-10-01', 'steps', 12_000);
  await put('ben', '2026-10-02', 'steps', 999);
});
afterAll(() => h.close());

const rings = (r: RingConfig) => ({ rings: r });

describe('ring config', () => {
  it('starts as the default three', async () => {
    const r = await h.call<{ rings: RingConfig }>('ann', 'GET', '/api/me/rings');
    expect(r.rings).toEqual(DEFAULT_RINGS);
  });

  it('saves a new setup for that person only, and Today follows', async () => {
    const next: RingConfig = [
      { metric: 'distance', goal: 8 },
      { metric: 'sleep', goal: 8 },
      { metric: 'steps', goal: 8000 },
    ];
    const saved = await h.call<{ rings: RingConfig }>('ann', 'PUT', '/api/me/rings', rings(next));
    expect(saved.rings).toEqual(next);
    expect((await h.call<{ rings: RingConfig }>('ann', 'GET', '/api/me/rings')).rings).toEqual(
      next,
    );
    expect((await h.call<{ rings: RingConfig }>('ben', 'GET', '/api/me/rings')).rings).toEqual(
      DEFAULT_RINGS,
    );

    const today = await h.call<TodayResponse>('ann', 'GET', '/api/me/today');
    expect(today.rings!.map((r) => [r.metric, r.label, r.unit, r.value, r.goal])).toEqual([
      ['distance', 'Distance', 'km', 4.5, 8],
      ['sleep', 'Sleep', 'h', 7.5, 8],
      ['steps', 'Steps', '', 6000, 8000],
    ]);
    // Older apps keep reading `metrics`.
    expect(today.metrics.find((m) => m.key === 'steps')!.value).toBe(6000);

    const benToday = await h.call<TodayResponse>('ben', 'GET', '/api/me/today');
    expect(benToday.rings!.map((r) => r.metric)).toEqual(DEFAULT_RINGS.map((r) => r.metric));
    expect(benToday.rings![0]!.value).toBe(999);
  });

  it('accepts the bare list too', async () => {
    const r = await h.call<{ rings: RingConfig }>('ben', 'PUT', '/api/me/rings', DEFAULT_RINGS);
    expect(r.rings).toEqual(DEFAULT_RINGS);
  });

  it('refuses a stat twice, an unknown stat, a missing ring and a goal of zero', async () => {
    const bad = [
      rings([DEFAULT_RINGS[0], DEFAULT_RINGS[0], DEFAULT_RINGS[1]] as RingConfig),
      rings([
        { metric: 'steps', goal: 1 },
        { metric: 'resting_hr', goal: 60 },
        { metric: 'sleep', goal: 8 },
      ] as never),
      { rings: [DEFAULT_RINGS[0], DEFAULT_RINGS[1]] },
      rings([{ metric: 'steps', goal: 0 }, DEFAULT_RINGS[1]!, DEFAULT_RINGS[2]!]),
      {},
    ];
    for (const body of bad) {
      const res = await h.raw('ann', 'PUT', '/api/me/rings', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    const dup = await h.raw(
      'ann',
      'PUT',
      '/api/me/rings',
      rings([DEFAULT_RINGS[0], DEFAULT_RINGS[0], DEFAULT_RINGS[1]] as RingConfig),
    );
    expect((dup.json() as { error: string }).error).toMatch(/different stat/);
    // Nothing changed.
    expect(
      (await h.call<{ rings: RingConfig }>('ann', 'GET', '/api/me/rings')).rings[0]!.metric,
    ).toBe('distance');
  });

  it('needs a signed-in person', async () => {
    expect((await h.raw(null, 'GET', '/api/me/rings')).statusCode).toBe(401);
    expect((await h.raw(null, 'PUT', '/api/me/rings', DEFAULT_RINGS)).statusCode).toBe(401);
    expect((await h.raw(null, 'GET', '/api/me/day')).statusCode).toBe(401);
  });

  it('falls back to the defaults if a stored setup no longer validates', async () => {
    await h.ctx.db
      .update(users)
      .set({ ringConfig: [{ metric: 'nope', goal: 1 }] as never })
      .where(eq(users.id, id('ben')));
    const r = await h.call<{ rings: RingConfig }>('ben', 'GET', '/api/me/rings');
    expect(r.rings).toEqual(DEFAULT_RINGS);
    await h.ctx.db
      .update(users)
      .set({ ringConfig: null })
      .where(eq(users.id, id('ben')));
  });

  it('lets the demo account change its rings (it is harmless)', () => {
    expect(demoRouteBlocked('PUT', '/api/me/rings')).toBe(false);
  });
});

describe('day stats', () => {
  it("shows today's stats in sections against the person's goals", async () => {
    const d = await h.call<DayResponse>('ann', 'GET', '/api/me/day');
    expect(d.date).toBe('2026-10-02');
    expect(d.isToday).toBe(true);
    expect(d.rings.map((r) => r.metric)).toEqual(['distance', 'sleep', 'steps']);
    expect(d.sections.map((s) => s.key)).toEqual(['activity', 'sleep', 'nutrition', 'body']);
    const all = d.sections.flatMap((s) => s.stats);
    expect(all.find((s) => s.key === 'steps')).toMatchObject({ value: 6000, goal: 8000 });
    expect(all.find((s) => s.key === 'calories_in')).toMatchObject({ value: 1800, goal: 2200 });
    expect(all.find((s) => s.key === 'weight')).toMatchObject({ value: 81.3, unit: 'kg' });
  });

  it('pages back to an earlier day and refuses the future and the far past', async () => {
    const y = await h.call<DayResponse>('ann', 'GET', '/api/me/day?date=2026-10-01');
    expect(y.isToday).toBe(false);
    expect(y.sections.flatMap((s) => s.stats).map((s) => [s.key, s.value])).toEqual([
      ['steps', 12_000],
    ]);
    for (const date of ['2026-10-03', '2025-01-01', 'yesterday', '2026-13-40']) {
      const res = await h.raw('ann', 'GET', `/api/me/day?date=${date}`);
      expect(res.statusCode, date).toBe(400);
    }
  });

  it("never shows someone else's numbers, whatever is asked", async () => {
    const ben = await h.call<DayResponse>('ben', 'GET', '/api/me/day');
    const all = ben.sections.flatMap((s) => s.stats);
    expect(all.map((s) => [s.key, s.value])).toEqual([['steps', 999]]);
    // A user id is not a thing this endpoint reads.
    const sneaky = await h.call<DayResponse>(
      'ben',
      'GET',
      `/api/me/day?user=${id('ann')}&userId=${id('ann')}`,
    );
    expect(sneaky.sections.flatMap((s) => s.stats).map((s) => s.value)).toEqual([999]);
  });

  it('is empty, not an error, for a day with nothing', async () => {
    const d = await h.call<DayResponse>('ben', 'GET', '/api/me/day?date=2026-09-20');
    expect(d.sections).toEqual([]);
    expect(d.rings.every((r) => r.value == null)).toBe(true);
  });
});

describe('badge summary', () => {
  it('is level 1 with nothing earned', async () => {
    const s = await h.call<BadgeSummary>('ann', 'GET', '/api/badges/summary');
    expect(s).toMatchObject({ earnedCount: 0, unseenCount: 0, latest: null });
    expect(s.level.level).toBe(1);
  });

  it('reports level, XP, count, unseen and the newest badge', async () => {
    await seedBadges(h.ctx);
    const defs = await h.ctx.db.query.badgeDefinitions.findMany({ limit: 2 });
    const [a, b] = defs;
    await h.ctx.db
      .update(users)
      .set({ badgeXp: 250 })
      .where(eq(users.id, id('ann')));
    await h.ctx.db.insert(userBadges).values([
      { userId: id('ann'), badgeKey: a!.key, tier: 1, earnedAt: new Date('2026-09-01T10:00:00Z') },
      {
        userId: id('ann'),
        badgeKey: b!.key,
        tier: 1,
        earnedAt: new Date('2026-09-20T10:00:00Z'),
        seenAt: new Date('2026-09-20T11:00:00Z'),
      },
    ]);
    const s = await h.call<BadgeSummary>('ann', 'GET', '/api/badges/summary');
    expect(s.earnedCount).toBe(2);
    expect(s.unseenCount).toBe(1);
    expect(s.level.xp).toBe(250);
    expect(s.level.nextLevelXp).toBeGreaterThan(250);
    expect(s.latest).toMatchObject({ key: b!.key, name: b!.name, tier: 1 });
    // Someone else's badges don't count.
    const other = await h.call<BadgeSummary>('ben', 'GET', '/api/badges/summary');
    expect(other.earnedCount).toBe(0);
  });
});
