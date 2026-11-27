/**
 * Badge status (0.15): where you stand on a badge, the real day each tier was earned and how, the
 * one-time redate of old backfilled rows, the timeline and the XP race against friends.
 */
import type {
  BadgeCatalogResponse,
  BadgeDetailResponse,
  BadgeDraft,
  BadgeTimelineResponse,
  XpRaceResponse,
} from '@gauntlet/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  activities,
  badgeDefinitions,
  challengeParticipants,
  challenges,
  dailyMetrics,
  serverState,
  userBadges,
  users,
} from '../src/db/schema.js';
import { checkBadges, recomputeXp } from '../src/services/badges/engine.js';
import { REDATE_KEY, redateBackfilledBadges } from '../src/services/badges/redate.js';
import { seedBadges } from '../src/services/badges/seed.js';
import { settleBadgeTasks } from '../src/services/badges/tasks.js';
import { findDemoUser, refreshDemo } from '../src/services/demo.js';
import { befriendAll, setup, type Harness } from './notifyHarness.js';

let h: Harness;
const NAMES = ['ann', 'ben', 'cat', 'dan'];
const id = (n: string) => h.ids[n]!;

beforeAll(async () => {
  h = await setup(NAMES, { env: { DEMO_ACCOUNT: 'true' } });
  await befriendAll(h, ['ann', 'ben', 'dan']);
});
afterAll(() => h.close());

beforeEach(async () => {
  await settleBadgeTasks();
  await h.ctx.db.delete(badgeDefinitions);
  await h.ctx.db.execute(sql`delete from notifications`);
  await h.ctx.db.delete(dailyMetrics);
  await h.ctx.db.delete(activities);
  await h.ctx.db.delete(challenges);
  await h.ctx.db.delete(serverState).where(eq(serverState.key, REDATE_KEY));
  await h.ctx.db.update(users).set({ badgeXp: 0, shareProfileStats: false, visibility: 'private' });
  await h.ctx.db
    .insert(serverState)
    .values(NAMES.map((w) => ({ key: `badge_init:${id(w)}`, value: true })))
    .onConflictDoNothing();
  h.setClock('2026-10-02T18:00:00Z');
});

type Rule = BadgeDraft['rule'];
const put = (key: string, rule: Rule, extra: Partial<typeof badgeDefinitions.$inferInsert> = {}) =>
  h.ctx.db.insert(badgeDefinitions).values({
    key,
    name: `Badge ${key}`,
    description: 'Do the thing {n}.',
    family: 'movement',
    icon: 'star',
    rule,
    status: 'live',
    origin: 'admin',
    ...extra,
  });
const metrics = async (who: string, metric: string, list: [string, number][]) =>
  h.ctx.db
    .insert(dailyMetrics)
    .values(list.map(([date, value]) => ({ userId: id(who), date, metric, value })))
    .onConflictDoUpdate({
      target: [dailyMetrics.userId, dailyMetrics.date, dailyMetrics.metric],
      set: { value: sql`excluded.value` },
    });
const days = (n: number, from: string) =>
  Array.from({ length: n }, (_, i) =>
    new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
  );
const check = (who: string, backfill = false, reason: 'sync' | 'challenge' = 'sync') =>
  checkBadges(h.ctx, id(who), { reason, backfill });
const detail = (who: string, key: string, user?: string) =>
  h.call<BadgeDetailResponse>(who, 'GET', `/api/badges/${key}${user ? `?user=${id(user)}` : ''}`);
const rowOf = async (who: string, key: string, tier = 1) =>
  (
    await h.ctx.db
      .select()
      .from(userBadges)
      .where(
        and(
          eq(userBadges.userId, id(who)),
          eq(userBadges.badgeKey, key),
          eq(userBadges.tier, tier),
        ),
      )
  )[0]!;
const grant = (
  who: string,
  key: string,
  tier: number,
  earnedAt: string,
  context: Record<string, unknown> = {},
  backfilled = false,
) =>
  h.ctx.db.insert(userBadges).values({
    userId: id(who),
    badgeKey: key,
    tier,
    earnedAt: new Date(earnedAt),
    context,
    backfilled,
  });

describe('where you stand', () => {
  const sleep: Rule = { type: 'streak', metric: 'sleep', min: 1, tiers: [10, 30] };
  const longRun = days(22, '2026-08-01');

  it('streak: current vs best, progress shows the current run, and next says what to do', async () => {
    await put('night', sleep);
    await metrics(
      'ann',
      'sleep',
      [...longRun, '2026-09-30', '2026-10-01'].map((d) => [d, 7]),
    );
    await check('ann');
    // Tiers are awarded on the best streak (22 >= 10)...
    expect((await rowOf('ann', 'night')).context).toMatchObject({
      date: '2026-08-10',
      from: '2026-08-01',
    });
    // ...but progress is about the run you are on now.
    const cat = await h.call<BadgeCatalogResponse>('ann', 'GET', '/api/badges');
    expect(cat.badges.find((b) => b.key === 'night')!.progress).toMatchObject({
      value: 2,
      target: 30,
      best: 22,
      label: '2 of 30',
    });
    const d = await detail('ann', 'night');
    expect(d.standing!.stats).toMatchObject([
      { kind: 'current', label: 'Current streak', value: '2 days', detail: 'Since Sep 30' },
      { kind: 'best', label: 'Best streak', value: '22 days', detail: 'Aug 1 – Aug 22, 2026' },
    ]);
    expect(d.standing!.next).toBe(
      'Log sleep today to keep your 2-day streak going; 28 more days in a row reaches Silver.',
    );
    expect(d.history[0]).toMatchObject({
      date: '2026-10-02',
      how: 'A 10-day streak, Aug 1 – Aug 10, 2026',
    });

    await metrics('ann', 'sleep', [['2026-10-02', 7]]);
    expect((await detail('ann', 'night')).standing!.next).toBe(
      '27 more days in a row reaches Silver.',
    );
    // Broken: nothing in the last two days.
    await h.ctx.db.delete(dailyMetrics).where(sql`date >= '2026-09-30'`);
    const broken = (await detail('ann', 'night')).standing!;
    expect(broken.stats[0]).toMatchObject({ value: '0 days', detail: 'Last counted Aug 22' });
    expect(broken.next).toBe('Start today: 30 days in a row reaches Silver.');
  });

  it('standing is only for your own live badge; others get none and no best', async () => {
    await put('night', sleep);
    await h.ctx.db
      .update(users)
      .set({ shareProfileStats: true })
      .where(eq(users.id, id('ann')));
    await metrics(
      'ann',
      'sleep',
      longRun.map((d) => [d, 7]),
    );
    await check('ann');
    expect((await detail('ben', 'night', 'ann')).standing).toBeNull();
    await h.ctx.db.update(badgeDefinitions).set({ status: 'retired' });
    expect((await detail('ann', 'night')).standing).toBeNull();
  });

  it('totals, windows, single tier and maxed out', async () => {
    await put('steps', { type: 'lifetime_total', metric: 'steps', tiers: [1000, 5000] });
    await metrics('ann', 'steps', [['2026-09-01', 1200]]);
    await check('ann');
    const s = (await detail('ann', 'steps')).standing!;
    expect(s.stats).toMatchObject([{ kind: 'total', label: 'Total so far', value: '1,200 steps' }]);
    expect(s.next).toBe('3,800 steps more reaches Silver.'.replace('steps more', 'steps more'));

    await put(
      'sprint',
      { type: 'lifetime_total', metric: 'steps', tiers: [4000] },
      { windowStart: '2026-09-01', windowEnd: '2026-10-31' },
    );
    expect((await detail('ann', 'sprint')).standing!.next).toBe(
      '2,800 steps more earns it if you get there by Oct 31.',
    );

    await metrics('ann', 'steps', [['2026-09-02', 9000]]);
    await check('ann');
    const maxed = (await detail('ann', 'steps')).standing!;
    expect(maxed.next).toBeNull();
    expect(maxed.stats[0]!.value).toBe('10,200 steps');
  });

  it('best week reports the best week and this week so far', async () => {
    await put('week', {
      type: 'best_period',
      metric: 'steps',
      period: 'week',
      tiers: [20000, 50000],
    });
    await metrics('ann', 'steps', [
      ['2026-09-14', 9000],
      ['2026-09-15', 9000],
      ['2026-09-16', 9000],
      ['2026-09-28', 4000],
      ['2026-10-01', 3000],
    ]);
    await check('ann');
    const s = (await detail('ann', 'week')).standing!;
    expect(s.stats).toMatchObject([
      { kind: 'best', label: 'Best week', value: '27,000 steps', detail: 'Week of Sep 14' },
      { kind: 'period', label: 'This week so far', value: '7,000 steps' },
    ]);
    expect(s.next).toBe('43,000 steps more this week reaches Silver.');
    expect((await rowOf('ann', 'week')).context).toMatchObject({
      date: '2026-09-16',
      from: '2026-09-14',
    });
  });

  it('challenges show the count and the latest one (linked only when you can open it)', async () => {
    await put('wins', { type: 'challenge_result', place: 1, tiers: [1, 3] });
    const ch = await finished({
      name: 'Spring Steps',
      who: [
        ['ann', 1, 100],
        ['cat', 2, 50],
      ],
    });
    await check('ann', false, 'challenge');
    const s = (await detail('ann', 'wins')).standing!;
    expect(s.stats).toMatchObject([
      { kind: 'total', value: '1' },
      { kind: 'latest', value: 'Spring Steps', to: `/c/${ch.id}` },
    ]);
    expect(s.next).toBe('2 more wins reaches Silver.');
  });
});

/** A finished private group challenge with these results. */
async function finished(opts: {
  name: string;
  who: [string, number, number][];
  visibility?: 'private' | 'public';
}) {
  const [ch] = await h.ctx.db
    .insert(challenges)
    .values({
      name: opts.name,
      metric: 'steps',
      aggregate: 'sum',
      scoring: 'total',
      startDate: '2026-09-01',
      endDate: '2026-09-10',
      timezone: 'UTC',
      createdBy: id(opts.who[0]![0]),
      finalizedAt: new Date('2026-09-11T00:00:00Z'),
      visibility: opts.visibility ?? 'private',
    })
    .returning();
  await h.ctx.db.insert(challengeParticipants).values(
    opts.who.map(([w, rank, score]) => ({
      challengeId: ch!.id,
      userId: id(w),
      state: 'joined' as const,
      finalRank: rank,
      finalScore: score,
    })),
  );
  return ch!;
}

describe('when and how it was earned', () => {
  it('records the day a threshold was really crossed, and words it', async () => {
    await put('steps', { type: 'lifetime_total', metric: 'steps', tiers: [1000, 5000] });
    await put('days', { type: 'count_days', metric: 'active_minutes', min: 30, tiers: [2, 3] });
    await put('runs', { type: 'activity_count', sport: 'run', tiers: [2] });
    await put('km', { type: 'activity_total', sport: 'run', measure: 'distance_km', tiers: [10] });
    await put('long', {
      type: 'single_activity',
      sport: 'run',
      measure: 'distance_km',
      tiers: [10],
    });
    await metrics('ann', 'steps', [
      ['2026-09-01', 600],
      ['2026-09-02', 600],
      ['2026-09-03', 4000],
    ]);
    await metrics('ann', 'active_minutes', [
      ['2026-09-05', 40],
      ['2026-09-06', 10],
      ['2026-09-07', 40],
      ['2026-09-10', 40],
    ]);
    for (const [aid, date, km] of [
      ['a1', '2026-09-01', 6],
      ['a2', '2026-09-03', 12.4],
    ] as const)
      await h.ctx.db.insert(activities).values({
        userId: id('ann'),
        id: aid,
        date,
        sport: 'run',
        name: 'Morning run',
        distanceKm: km,
      });
    await check('ann', true);

    expect((await rowOf('ann', 'steps', 1)).context.date).toBe('2026-09-02');
    expect((await rowOf('ann', 'steps', 2)).context.date).toBe('2026-09-03');
    expect((await rowOf('ann', 'days', 1)).context.date).toBe('2026-09-07');
    expect((await rowOf('ann', 'days', 2)).context.date).toBe('2026-09-10');
    expect((await rowOf('ann', 'runs')).context.date).toBe('2026-09-03');
    expect((await rowOf('ann', 'km')).context.date).toBe('2026-09-03'); // 6 + 12.4 >= 10
    expect((await rowOf('ann', 'long')).context).toMatchObject({ date: '2026-09-03', value: 12.4 });

    // Backfilled rows report the real day, not the backfill day.
    const d = await detail('ann', 'steps');
    expect(d.history.map((e) => [e.tier, e.date, e.how])).toEqual([
      [1, '2026-09-02', 'Reached 1,000 steps on Sep 2'],
      [2, '2026-09-03', 'Reached 5,000 steps on Sep 3'],
    ]);
    expect((await detail('ann', 'long')).history[0]!.how).toBe('A 12.4 km run on Sep 3');
    expect((await detail('ann', 'runs')).history[0]!.how).toBe('Your 2nd run on Sep 3');
  });

  it('challenge entries link and name the challenge, but never leak a private one', async () => {
    await put('wins', { type: 'challenge_result', place: 1, tiers: [1] });
    await h.ctx.db
      .update(users)
      .set({ shareProfileStats: true })
      .where(eq(users.id, id('ann')));
    const ch = await finished({
      name: 'Secret Cup',
      who: [
        ['ann', 1, 100],
        ['cat', 2, 50],
      ],
    });
    await check('ann', false, 'challenge');
    const mine = (await detail('ann', 'wins')).history[0]!;
    expect(mine).toMatchObject({ how: 'Won Secret Cup', to: `/c/${ch.id}` });
    // ben is not in the (private) challenge.
    const seen = (await detail('ben', 'wins', 'ann')).history[0]!;
    expect(seen.to).toBeNull();
    expect(seen.how).toBe('Won a challenge on Sep 10');
    expect(JSON.stringify(seen.context)).not.toContain('Secret Cup');
    await h.ctx.db.update(challenges).set({ visibility: 'public' });
    expect((await detail('ben', 'wins', 'ann')).history[0]).toMatchObject({
      how: 'Won Secret Cup',
      to: `/c/${ch.id}`,
    });
  });
});

describe('the one-time redate', () => {
  it('moves backfilled dates earlier once, and changes nothing else', async () => {
    await put('steps', { type: 'lifetime_total', metric: 'steps', tiers: [1000, 5000] });
    await metrics('ann', 'steps', [
      ['2026-09-02', 1200],
      ['2026-09-03', 4000],
    ]);
    const at = '2026-10-02T18:00:00Z';
    await grant('ann', 'steps', 1, at, { date: '2026-10-02' }, true); // the backfill day
    await grant('ann', 'steps', 2, at, { date: '2026-08-01' }, true); // already earlier: keep
    await grant('ann', 'steps', 1, at, {}, false).catch(() => undefined); // dup key ignored
    await recomputeXp(h.ctx, id('ann'));
    const xp = (
      await h.ctx.db
        .select()
        .from(users)
        .where(eq(users.id, id('ann')))
    )[0]!.badgeXp;

    expect(await redateBackfilledBadges(h.ctx)).toBe(1);
    expect((await rowOf('ann', 'steps', 1)).context.date).toBe('2026-09-02');
    expect((await rowOf('ann', 'steps', 2)).context.date).toBe('2026-08-01');
    const r = await rowOf('ann', 'steps', 1);
    expect(r.earnedAt.toISOString()).toBe('2026-10-02T18:00:00.000Z');
    expect(
      (
        await h.ctx.db
          .select()
          .from(users)
          .where(eq(users.id, id('ann')))
      )[0]!.badgeXp,
    ).toBe(xp);

    // Once only.
    await h.ctx.db.update(userBadges).set({ context: { date: '2026-10-02' } });
    expect(await redateBackfilledBadges(h.ctx)).toBeNull();
    expect((await rowOf('ann', 'steps', 1)).context.date).toBe('2026-10-02');
  });
});

describe('timeline', () => {
  async function earnedSet() {
    await put('a', { type: 'lifetime_total', metric: 'steps', tiers: [1, 2] });
    await put('b', { type: 'lifetime_total', metric: 'distance', tiers: [1] });
    await put(
      'draft',
      { type: 'lifetime_total', metric: 'water', tiers: [1] },
      { status: 'draft' },
    );
    await put(
      'old',
      { type: 'lifetime_total', metric: 'workouts', tiers: [1] },
      { status: 'retired' },
    );
    await grant('ann', 'a', 1, '2026-09-10T10:00:00Z');
    await grant('ann', 'a', 2, '2026-09-20T10:00:00Z');
    await grant('ann', 'b', 1, '2026-10-01T00:00:00Z', { date: '2026-08-15' }, true);
    await grant('ann', 'old', 1, '2026-09-20T12:00:00Z');
    await grant('ann', 'draft', 1, '2026-09-25T12:00:00Z');
  }

  it('lists newest first by real date, pages with an opaque cursor, hides drafts', async () => {
    await earnedSet();
    await h.ctx.db
      .update(users)
      .set({ shareProfileStats: true })
      .where(eq(users.id, id('ann')));
    const get = (q = '') =>
      h.call<BadgeTimelineResponse>('ann', 'GET', `/api/users/${id('ann')}/badges/timeline${q}`);
    const all = await get();
    expect(all.entries.map((e) => `${e.key}:${e.tier}:${e.date}`)).toEqual([
      'old:1:2026-09-20',
      'a:2:2026-09-20',
      'a:1:2026-09-10',
      'b:1:2026-08-15',
    ]);
    expect(all.nextCursor).toBeNull();
    expect(all.entries.find((e) => e.key === 'b')).toMatchObject({
      backfilled: true,
      tierCount: 1,
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p: BadgeTimelineResponse = await get(`?limit=3${cursor ? `&before=${cursor}` : ''}`);
      seen.push(...p.entries.map((e) => `${e.key}:${e.tier}`));
      cursor = p.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(2);
    expect(seen).toEqual(all.entries.map((e) => `${e.key}:${e.tier}`));

    expect(
      (await h.raw('ann', 'GET', `/api/users/${id('ann')}/badges/timeline?before=nope`)).statusCode,
    ).toBe(400);
    expect(
      (await h.raw('ann', 'GET', `/api/users/${id('ann')}/badges/timeline?limit=101`)).statusCode,
    ).toBe(400);
  });

  it('follows badge privacy: strangers and non-sharing friends get 404', async () => {
    await earnedSet();
    const url = (w: string) => `/api/users/${id(w)}/badges/timeline`;
    expect((await h.raw('ben', 'GET', url('ann'))).statusCode).toBe(404); // not sharing
    expect((await h.raw('cat', 'GET', url('ann'))).statusCode).toBe(404);
    await h.ctx.db
      .update(users)
      .set({ shareProfileStats: true })
      .where(eq(users.id, id('ann')));
    expect((await h.raw('ben', 'GET', url('ann'))).statusCode).toBe(200);
    expect((await h.raw('cat', 'GET', url('ann'))).statusCode).toBe(404); // can't see her at all
    expect((await h.raw('dan', 'GET', url('ben'))).statusCode).toBe(404);
    expect((await h.raw('ann', 'GET', url('ann'))).statusCode).toBe(200);
  });
});

describe('XP race', () => {
  const race = (who: string, range = '') =>
    h.call<XpRaceResponse>(who, 'GET', `/api/badges/race${range}`);
  const xpOf = async (who: string) =>
    (
      await h.ctx.db
        .select()
        .from(users)
        .where(eq(users.id, id(who)))
    )[0]!.badgeXp;

  async function seedRace() {
    await put('a', { type: 'lifetime_total', metric: 'steps', tiers: [1, 2, 3] });
    await grant('ann', 'a', 1, '2026-09-10T10:00:00Z');
    await grant('ann', 'a', 2, '2026-09-20T10:00:00Z');
    await grant('ben', 'a', 1, '2026-09-25T10:00:00Z');
    await grant('dan', 'a', 1, '2026-09-25T10:00:00Z');
    await grant('cat', 'a', 1, '2026-09-25T10:00:00Z');
    for (const w of NAMES) await recomputeXp(h.ctx, id(w));
    await h.ctx.db
      .update(users)
      .set({ shareProfileStats: true })
      .where(sql`id in (${id('ben')}, ${id('cat')})`);
  }

  it('draws you and sharing friends only, ending at each total XP, daily for 30 days', async () => {
    await seedRace();
    const r = await race('ann', '?range=30d');
    expect(r.range).toBe('30d');
    expect(r.dates).toHaveLength(30);
    expect(r.dates.at(-1)).toBe('2026-10-02');
    // dan keeps stats private, cat is not a friend.
    expect(r.series.map((s) => s.user.id).sort()).toEqual([id('ann'), id('ben')].sort());
    expect(r.total).toBe(2);
    expect(r.truncated).toBe(false);
    for (const s of r.series) {
      const who = s.isMe ? 'ann' : 'ben';
      expect(s.values.at(-1)).toBe(await xpOf(who));
      expect(s.values).toEqual([...s.values].sort((a, b) => a! - b!));
    }
    const me = r.series.find((s) => s.isMe)!;
    const i = r.dates.indexOf('2026-09-20');
    expect(me.values[i]! - me.values[i - 1]!).toBeGreaterThan(0);
    expect(r.series.map((s) => s.rank)).toEqual([1, 2]);
    // Gained within the range: everything here was earned inside it.
    expect(r.gained[r.series.indexOf(me)]).toBe(await xpOf('ann'));
  });

  it('defaults to 90 days, rejects unknown ranges, and counts earlier XP as the starting point', async () => {
    await seedRace();
    await grant('ben', 'a', 2, '2026-05-01T10:00:00Z');
    await recomputeXp(h.ctx, id('ben'));
    const r = await race('ann');
    expect(r.range).toBe('90d');
    expect(r.dates).toHaveLength(90);
    const ben = r.series.find((s) => !s.isMe)!;
    expect(ben.values[0]).toBeGreaterThan(0);
    expect(ben.values.at(-1)).toBe(await xpOf('ben'));
    expect(r.gained[r.series.indexOf(ben)]).toBeLessThan(await xpOf('ben'));
    expect((await h.raw('ann', 'GET', '/api/badges/race?range=7d')).statusCode).toBe(400);
  });

  it('all time goes weekly once it spans more than ~400 days', async () => {
    await seedRace();
    await grant('ben', 'a', 3, '2024-01-10T10:00:00Z');
    await recomputeXp(h.ctx, id('ben'));
    const r = await race('ann', '?range=all');
    expect(r.dates.at(-1)).toBe('2026-10-02');
    expect(r.dates[0]! <= '2024-01-10').toBe(true);
    const gap = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;
    for (let i = 1; i < r.dates.length; i++) expect(gap(r.dates[i - 1]!, r.dates[i]!)).toBe(7);
    for (const s of r.series) expect(s.values).toHaveLength(r.dates.length);
    const ben = r.series.find((s) => !s.isMe)!;
    expect(ben.values.at(-1)).toBe(await xpOf('ben'));
  });

  it('keeps the top 7 friends plus you', async () => {
    await seedRace();
    for (let i = 0; i < 9; i++) {
      const [u] = await h.ctx.db
        .insert(users)
        .values({
          sparkyUserId: `x-${i}`,
          email: `x${i}@example.com`,
          displayName: `Extra ${i}`,
          shareProfileStats: true,
          badgeXp: 10 + i,
        })
        .returning();
      const [lo, hi] = id('ann') < u!.id ? [id('ann'), u!.id] : [u!.id, id('ann')];
      await h.ctx.db.execute(
        sql`insert into friendships (user_low, user_high, requested_by, status) values (${lo}, ${hi}, ${id('ann')}, 'accepted')`,
      );
    }
    const r = await race('ann', '?range=30d');
    expect(r.series).toHaveLength(8);
    expect(r.truncated).toBe(true);
    expect(r.total).toBe(11); // ben + 9 extras + you
    expect(r.series.some((s) => s.isMe)).toBe(true);
  });

  it('works for the demo account with the demo cast', async () => {
    await seedBadges(h.ctx);
    await settleBadgeTasks();
    await refreshDemo(h.ctx);
    const demo = (await findDemoUser(h.ctx))!;
    h.ids.demo = demo.id;
    const r = await race('demo', '?range=30d');
    expect(r.series.length).toBeGreaterThan(2);
    for (const s of r.series) {
      const [u] = await h.ctx.db.select().from(users).where(eq(users.id, s.user.id));
      expect(s.values.at(-1)).toBe(u!.badgeXp);
    }
  });
});
