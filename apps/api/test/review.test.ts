import type {
  AppNotification,
  HeatmapResponse,
  NotificationsPage,
  Review,
  ReviewList,
} from '@gauntlet/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  challengeParticipants,
  challenges,
  dailyMetrics,
  personalRecords,
  users,
} from '../src/db/schema.js';
import { runSyncCycle } from '../src/scheduler.js';
import { sendMonthReviews } from '../src/services/review.js';
import { setup, type Harness } from './notifyHarness.js';

let h: Harness;
beforeAll(async () => {
  h = await setup(['ann', 'ben', 'cat', 'dan', 'eve'], { clock: '2026-11-26T12:00:00Z' });
  await h.call('ann', 'POST', '/api/friends/requests', { email: 'ben@example.com' });
  await h.call('ben', 'POST', `/api/friends/requests/${h.ids.ann}/accept`);
});
afterAll(() => h.close());

const day = (who: string, date: string, metric: string, value: number) =>
  h.ctx.db
    .insert(dailyMetrics)
    .values({ userId: h.ids[who]!, date, metric, value })
    .onConflictDoUpdate({
      target: [dailyMetrics.userId, dailyMetrics.date, dailyMetrics.metric],
      set: { value },
    });

/** A finished group challenge ending on `end`, with each person's final rank. */
async function finished(name: string, end: string, ranks: [string, number][]) {
  const [ch] = await h.ctx.db
    .insert(challenges)
    .values({
      name,
      metric: 'steps',
      aggregate: 'sum',
      scoring: 'total',
      startDate: end,
      endDate: end,
      timezone: 'UTC',
      createdBy: h.ids[ranks[0]![0]]!,
      finalizedAt: new Date(`${end}T23:00:00Z`),
    })
    .returning();
  await h.ctx.db.insert(challengeParticipants).values(
    ranks.map(([who, rank]) => ({
      challengeId: ch!.id,
      userId: h.ids[who]!,
      state: 'joined' as const,
      finalRank: rank,
      finalScore: 1000 - rank,
    })),
  );
}

const inbox = async (who: string): Promise<AppNotification[]> =>
  (await h.call<NotificationsPage>(who, 'GET', '/api/notifications')).items.filter(
    (n) => n.kind === 'month_review',
  );

describe('review data', () => {
  beforeAll(async () => {
    // October: 10k steps a day for 4 days. November: more, with a three-day 10k streak.
    for (const d of ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'])
      await day('ann', d, 'steps', 10000);
    for (let i = 1; i <= 20; i++) {
      const date = `2026-11-${String(i).padStart(2, '0')}`;
      // 2026-11-07 and -14 are Saturdays: the big days.
      const sat = i === 7 || i === 14;
      await day('ann', date, 'steps', sat ? 16000 : i >= 10 && i <= 12 ? 11000 : 5000);
      await day('ann', date, 'active_minutes', 30);
    }
    await day('ann', '2026-11-14', 'workouts', 1);
    await day('ann', '2026-11-14', 'distance', 12.3);
    await h.ctx.db.insert(personalRecords).values([
      { userId: h.ids.ann!, key: 'steps_day', value: 16000, date: '2026-11-14' },
      { userId: h.ids.ann!, key: 'steps_day_old', value: 1, date: '2026-11-14' },
      { userId: h.ids.ann!, key: 'distance_day', value: 14, date: '2026-10-20' },
    ]);
    await finished('Ann beats Ben', '2026-11-10', [
      ['ann', 1],
      ['ben', 2],
      ['cat', 3],
    ]);
    await finished('Ben beats Ann', '2026-11-15', [
      ['ben', 1],
      ['ann', 2],
    ]);
    await finished('Ann again', '2026-11-18', [
      ['ann', 1],
      ['ben', 2],
    ]);
    await finished('Ann and Cat', '2026-11-19', [
      ['cat', 1],
      ['ann', 4],
    ]);
    await finished('October one', '2026-10-30', [
      ['ann', 1],
      ['ben', 2],
    ]);
  });

  it('builds a month: totals vs last month, best day, streak, records, challenges and rival', async () => {
    const r = await h.call<Review>('ann', 'GET', '/api/me/review/2026-11');
    expect(r).toMatchObject({
      period: '2026-11',
      kind: 'month',
      label: 'November 2026',
      prevLabel: 'October',
      start: '2026-11-01',
      end: '2026-11-30',
      partial: true,
      hasData: true,
      activeDays: 20,
      bestDay: { date: '2026-11-07', steps: 16000 },
      longestStreak: { days: 3, start: '2026-11-10', end: '2026-11-12' },
      bestMonth: null,
    });
    const total = (k: string) => r.totals.find((t) => t.key === k)!;
    // 16k x 2 Saturdays + 11k x 3 + 5k x 15
    expect(total('steps')).toMatchObject({ value: 140000, previous: 40000, changePct: 250 });
    expect(total('workouts').value).toBe(1);
    expect(total('distance').value).toBe(12.3);
    expect(r.weekday).toMatchObject({ name: 'Saturday', avgSteps: 16000 });
    expect(r.records).toEqual([{ label: 'Best step day', badge: '16,000', date: '2026-11-14' }]);
    expect(r.challenges).toEqual({ played: 4, won: 2, podiums: 3 });
    expect(r.rival).toEqual({
      userId: h.ids.ben,
      displayName: 'ben',
      shared: 3,
      wins: 2,
      losses: 1,
    });
  });

  it('builds a year, with its best month, and the days of a finished month are not partial', async () => {
    const y = await h.call<Review>('ann', 'GET', '/api/me/review/2026');
    expect(y).toMatchObject({ kind: 'year', label: '2026', partial: true, activeDays: 24 });
    expect(y.bestMonth).toMatchObject({ month: '2026-11', label: 'November', steps: 140000 });
    expect(y.challenges.played).toBe(5);
    expect(y.records.map((x) => x.label)).toEqual(['Best distance day', 'Best step day']);
    const oct = await h.call<Review>('ann', 'GET', '/api/me/review/2026-10');
    expect(oct.partial).toBe(false);
    expect(oct.longestStreak).toMatchObject({ days: 4 });
  });

  it('says so when a period is empty, and lists the months that have data', async () => {
    const empty = await h.call<Review>('cat', 'GET', '/api/me/review/2026-11');
    expect(empty).toMatchObject({ hasData: false, bestDay: null, weekday: null });
    // Cat has no numbers that month, but she did play Ann twice.
    expect(empty.rival).toMatchObject({ displayName: 'ann', shared: 2 });
    expect(await h.call<ReviewList>('ann', 'GET', '/api/me/reviews')).toEqual({
      months: ['2026-11', '2026-10'],
      years: ['2026'],
    });
    expect(await h.call<ReviewList>('cat', 'GET', '/api/me/reviews')).toEqual({
      months: [],
      years: [],
    });
  });

  it('is only yours: needs sign-in, and a period must be real', async () => {
    expect((await h.raw(null, 'GET', '/api/me/review/2026-11')).statusCode).toBe(401);
    expect((await h.raw('ann', 'GET', '/api/me/review/2026-13')).statusCode).toBe(400);
    expect((await h.raw('ann', 'GET', '/api/me/review/last-month')).statusCode).toBe(400);
    // Ben asking gets Ben's own numbers, never Ann's.
    const ben = await h.call<Review>('ben', 'GET', '/api/me/review/2026-11');
    expect(ben.hasData).toBe(false);
  });
});

describe('heatmap', () => {
  const get = (who: string, target: string, q = '') =>
    h.raw(who, 'GET', `/api/users/${h.ids[target]}/heatmap${q}`);
  const setUser = (who: string, set: Partial<typeof users.$inferInsert>) =>
    h.ctx.db.update(users).set(set).where(eq(users.id, h.ids[who]!));

  it('returns the last 365 days of one metric, non-zero days only', async () => {
    const r = await h.call<HeatmapResponse>('ann', 'GET', `/api/users/${h.ids.ann}/heatmap`);
    expect(r).toMatchObject({
      metric: 'steps',
      label: 'Steps',
      start: '2025-11-27',
      end: '2026-11-26',
    });
    expect(r.days).toHaveLength(24);
    expect(r.days[0]).toEqual(['2026-10-05', 10000]);
    const km = await h.call<HeatmapResponse>(
      'ann',
      'GET',
      `/api/users/${h.ids.ann}/heatmap?metric=distance`,
    );
    expect(km).toMatchObject({ unit: 'km', days: [['2026-11-14', 12.3]] });
  });

  it('can show a calendar year instead', async () => {
    const r = await h.call<HeatmapResponse>(
      'ann',
      'GET',
      `/api/users/${h.ids.ann}/heatmap?year=2026`,
    );
    expect(r).toMatchObject({ start: '2026-01-01', end: '2026-11-26' });
    const past = await h.call<HeatmapResponse>(
      'ann',
      'GET',
      `/api/users/${h.ids.ann}/heatmap?year=2025`,
    );
    expect(past).toMatchObject({ start: '2025-01-01', end: '2025-12-31', days: [] });
  });

  it('only offers daily numbers that belong on a profile, and needs a sign-in', async () => {
    expect((await get('ann', 'ann', '?metric=sleep')).statusCode).toBe(400);
    expect((await get('ann', 'ann', '?metric=weight')).statusCode).toBe(400);
    expect((await get('ann', 'ann', '?year=1999')).statusCode).toBe(400);
    expect((await h.raw(null, 'GET', `/api/users/${h.ids.ann}/heatmap`)).statusCode).toBe(401);
    expect((await h.raw('ann', 'GET', '/api/users/not-an-id/heatmap')).statusCode).toBe(404);
  });

  it("shows a friend's only when they share stats", async () => {
    // Ben is Ann's friend and keeps his stats to himself.
    expect((await get('ann', 'ben')).statusCode).toBe(403);
    // Always your own, even when you keep stats private.
    expect((await get('ben', 'ben')).statusCode).toBe(200);
    await setUser('ben', { shareProfileStats: true });
    expect((await get('ann', 'ben')).statusCode).toBe(200);
    await setUser('ben', { shareProfileStats: false });
  });

  it('follows who can see the person at all: challenge-mates yes, strangers no, public yes', async () => {
    // Cat shares challenges with Ann but isn't a friend; Dan and Eve are strangers.
    await setUser('ann', { shareProfileStats: true });
    expect((await get('cat', 'ann')).statusCode).toBe(200);
    expect((await get('dan', 'ann')).statusCode).toBe(404);
    await setUser('ann', { visibility: 'public' });
    expect((await get('dan', 'ann')).statusCode).toBe(200);
    // Public but not sharing stats: visible profile, hidden heatmap.
    await setUser('ann', { shareProfileStats: false });
    expect((await get('dan', 'ann')).statusCode).toBe(403);
    expect((await get('ann', 'ann')).statusCode).toBe(200);
    await setUser('ann', { visibility: 'private' });
  });
});

describe('month review notification', () => {
  it('goes out once per person after 7:00 local in the first week, and sets lastReviewMonth', async () => {
    await h.ctx.db
      .update(users)
      .set({ timezone: 'America/Los_Angeles' })
      .where(eq(users.id, h.ids.cat!));
    await day('cat', '2026-11-03', 'steps', 9000);

    // Mid-month, and the 1st before 7:00, send nothing.
    h.setClock('2026-11-26T12:00:00Z');
    expect(await sendMonthReviews(h.ctx)).toBe(0);
    h.setClock('2026-12-01T06:00:00Z');
    expect(await sendMonthReviews(h.ctx)).toBe(0);
    expect(await inbox('ann')).toHaveLength(0);

    // 08:00 UTC on 1 December: Ann (UTC) is up. Cat's Los Angeles clock still says Nov 30 at midnight.
    h.setClock('2026-12-01T08:00:00Z');
    expect(await sendMonthReviews(h.ctx)).toBe(1);
    const ann = await inbox('ann');
    expect(ann).toHaveLength(1);
    expect(ann[0]).toMatchObject({ title: 'Your November 2026 in review', url: '/review/2026-11' });
    expect(ann[0]!.body).toContain('140k steps');
    expect(ann[0]!.body).toContain('+250% on October');
    const lastOf = async (who: string) =>
      (await h.ctx.db.select().from(users).where(eq(users.id, h.ids[who]!)))[0]!.lastReviewMonth;
    expect(await lastOf('ann')).toBe('2026-11');
    expect(await lastOf('cat')).toBeNull();
    // Ben had nothing recorded: no message, but the month is marked done.
    expect(await inbox('ben')).toHaveLength(0);
    expect(await lastOf('ben')).toBe('2026-11');

    // Again, later that day and on the next days: not repeated. Through the real cycle too.
    expect(await sendMonthReviews(h.ctx)).toBe(0);
    h.setClock('2026-12-03T10:00:00Z');
    await runSyncCycle(h.ctx);
    expect(await inbox('ann')).toHaveLength(1);

    // Cat is in Los Angeles: her first week has begun by 15:30 UTC (07:30 there).
    expect(await inbox('cat')).toHaveLength(1);
    expect(await lastOf('cat')).toBe('2026-11');
  });

  it('never goes to someone after the first week, to demo users, or to people who opted out', async () => {
    // Dan has data but the month is already past day 7; Eve opted out and is in the window.
    await day('dan', '2026-11-03', 'steps', 9000);
    await day('eve', '2026-11-03', 'steps', 9000);
    await h.call('eve', 'PUT', '/api/me/notification-prefs', { prefs: { month_review: false } });
    h.setClock('2026-12-09T10:00:00Z');
    expect(await sendMonthReviews(h.ctx)).toBe(0);
    expect(await inbox('dan')).toHaveLength(0);

    h.setClock('2026-12-05T10:00:00Z');
    await h.ctx.db.update(users).set({ isDemo: true }).where(eq(users.id, h.ids.dan!));
    await sendMonthReviews(h.ctx);
    expect(await inbox('dan')).toHaveLength(0);
    expect(await inbox('eve')).toHaveLength(0);
    const [eve] = await h.ctx.db.select().from(users).where(eq(users.id, h.ids.eve!));
    expect(eve!.lastReviewMonth).toBe('2026-11');
  });

  it('in January sends one message, for the whole year, and marks December done', async () => {
    await day('ann', '2026-12-10', 'steps', 8000);
    h.setClock('2027-01-02T09:00:00Z');
    expect(await sendMonthReviews(h.ctx)).toBeGreaterThanOrEqual(1);
    const ann = await inbox('ann');
    expect(ann).toHaveLength(2);
    expect(ann[0]).toMatchObject({ title: 'Your 2026 in review', url: '/review/2026' });
    const [row] = await h.ctx.db.select().from(users).where(eq(users.id, h.ids.ann!));
    expect(row!.lastReviewMonth).toBe('2026-12');
    expect(await sendMonthReviews(h.ctx)).toBe(0);
  });
});
