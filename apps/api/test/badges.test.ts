/**
 * Badge engine: each rule type earns what it should, windows and manual entries are respected,
 * checks are idempotent and announce once, and the admin/API surface behaves (privacy, admin-only,
 * image validation, showcase, retire/edit/preview).
 */
import { randomUUID } from 'node:crypto';
import type {
  AdminBadge,
  BadgeCatalogResponse,
  BadgeDetailResponse,
  BadgeDraft,
  BadgePreviewResponse,
  FeedEvent,
  NotificationsPage,
  UnseenBadgesResponse,
} from '@gauntlet/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  activities,
  badgeDefinitions,
  challengeParticipants,
  challenges,
  dailyMetrics,
  feedEvents,
  friendships,
  rankSnapshots,
  serverState,
  userBadges,
  users,
} from '../src/db/schema.js';
import { checkBadges } from '../src/services/badges/engine.js';
import { builtinDrafts, seedBadges } from '../src/services/badges/seed.js';
import { settleBadgeTasks } from '../src/services/badges/tasks.js';
import { finalizeChallenge } from '../src/services/challenges.js';
import { findDemoUser, refreshDemo } from '../src/services/demo.js';
import { syncUser } from '../src/services/sync.js';
import { pair } from '../src/services/friends.js';
import { befriendAll, setup, type Harness } from './notifyHarness.js';

let h: Harness;
const NAMES = ['ann', 'ben', 'cat', 'boss'];
const id = (n: string) => h.ids[n]!;

beforeAll(async () => {
  h = await setup(NAMES, { env: { ADMIN_EMAILS: 'boss@example.com', DEMO_ACCOUNT: 'true' } });
  await befriendAll(h, ['ann', 'ben']);
});
afterAll(() => h.close());

/** Everything starts empty; users count as already past their first check unless a test says not. */
beforeEach(async () => {
  await settleBadgeTasks();
  await h.ctx.db.delete(badgeDefinitions);
  await h.ctx.db.delete(feedEvents).where(sql`kind in ('badge_earned', 'personal_record')`);
  await h.ctx.db.execute(sql`delete from notifications; delete from badge_images`);
  await h.ctx.db.delete(dailyMetrics);
  await h.ctx.db.delete(activities);
  await h.ctx.db.delete(challenges);
  await h.ctx.db.update(users).set({ badgeXp: 0, badgeShowcase: [], shareProfileStats: false });
  await init(...NAMES);
  h.setClock('2026-10-02T18:00:00Z');
});

const init = async (...who: string[]) => {
  await h.ctx.db
    .insert(serverState)
    .values(who.map((w) => ({ key: `badge_init:${id(w)}`, value: true })))
    .onConflictDoNothing();
};

type Rule = BadgeDraft['rule'];
const put = async (
  key: string,
  rule: Rule,
  extra: Partial<typeof badgeDefinitions.$inferInsert> = {},
) =>
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

const metrics = async (who: string, metric: string, list: [string, number][]) => {
  if (list.length)
    await h.ctx.db
      .insert(dailyMetrics)
      .values(list.map(([date, value]) => ({ userId: id(who), date, metric, value })))
      .onConflictDoUpdate({
        target: [dailyMetrics.userId, dailyMetrics.date, dailyMetrics.metric],
        set: { value: sql`excluded.value` },
      });
};
const act = async (
  who: string,
  a: Partial<typeof activities.$inferInsert> & { id: string; date: string },
) =>
  h.ctx.db.insert(activities).values({
    userId: id(who),
    sport: 'run',
    name: 'Run',
    ...a,
  });

const check = (who: string, reason: 'sync' | 'challenge' | 'social' = 'sync') =>
  checkBadges(h.ctx, id(who), { reason });
const tiersOf = async (who: string, key: string) =>
  (
    await h.ctx.db
      .select({ tier: userBadges.tier })
      .from(userBadges)
      .where(and(eq(userBadges.userId, id(who)), eq(userBadges.badgeKey, key)))
  )
    .map((r) => r.tier)
    .sort();
const notes = async (who: string) =>
  (await h.call<NotificationsPage>(who, 'GET', '/api/notifications')).items.filter(
    (n) => n.kind === 'badge',
  );
const feed = async (who: string) =>
  (await h.call<FeedEvent[]>(who, 'GET', '/api/feed')).filter((e) => e.kind === 'badge_earned');

const days = (n: number, from = '2026-09-01') =>
  Array.from({ length: n }, (_, i) =>
    new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
  );

/** A finished group challenge with these results (rank, score per person). */
async function finished(opts: {
  name?: string;
  who: [string, number, number | null][];
  start?: string;
  end?: string;
  team?: boolean;
  rematch?: boolean;
  stake?: boolean;
  settled?: boolean;
  solo?: boolean;
  metric?: string;
  invitedBy?: Record<string, string>;
}) {
  const [ch] = await h.ctx.db
    .insert(challenges)
    .values({
      name: opts.name ?? 'Test challenge',
      metric: opts.metric ?? 'steps',
      aggregate: 'sum',
      scoring: 'total',
      startDate: opts.start ?? '2026-09-01',
      endDate: opts.end ?? '2026-09-10',
      timezone: 'UTC',
      createdBy: id(opts.who[0]![0]),
      finalizedAt: new Date('2026-09-11T00:00:00Z'),
      teamScoring: opts.team ? 'sum' : null,
      rematchOf: opts.rematch ? randomUUID() : null,
      stake: opts.stake ? 'Loser buys coffee' : null,
      stakeSettledAt: opts.settled ? new Date('2026-09-12T00:00:00Z') : null,
      solo: opts.solo ? { kind: 'target' } : null,
    })
    .returning();
  await h.ctx.db.insert(challengeParticipants).values(
    opts.who.map(([w, rank, score]) => ({
      challengeId: ch!.id,
      userId: id(w),
      state: 'joined' as const,
      finalRank: rank,
      finalScore: score,
      teamId: opts.team ? randomUUID() : null,
      invitedBy: opts.invitedBy?.[w] ? id(opts.invitedBy[w]!) : null,
    })),
  );
  return ch!;
}

describe('the launch badges', () => {
  it('all validate, have unique keys, and every family is covered', () => {
    const drafts = builtinDrafts();
    expect(drafts.length).toBeGreaterThanOrEqual(38);
    expect(new Set(drafts.map((d) => d.key)).size).toBe(drafts.length);
    const fams = new Set(drafts.map((d) => d.family));
    for (const f of [
      'movement',
      'big_days',
      'consistency',
      'competition',
      'drama',
      'rivalry',
      'social',
      'strength',
      'fasting',
      'secret',
    ])
      expect(fams.has(f as never), f).toBe(true);
    for (const d of drafts) {
      if ('tiers' in d.rule && d.rule.tiers.length > 1)
        expect(d.description, d.key).toContain('{n}');
    }
  });

  it('seeds live builtins once, never touches customised or admin ones, and bumps a changed rule', async () => {
    const added = await seedBadges(h.ctx);
    await settleBadgeTasks();
    expect(added.length).toBe(builtinDrafts().length);
    const all = await h.ctx.db.select().from(badgeDefinitions);
    expect(all.every((d) => d.status === 'live' && d.origin === 'builtin')).toBe(true);
    expect(await seedBadges(h.ctx)).toEqual([]);

    // An admin edits one, retires another, and has their own badge: the seed leaves all alone.
    await h.call('boss', 'PUT', '/api/admin/badges/long-haul', {
      ...(await adminBadge('long-haul')),
      name: 'Marathon Walker',
    });
    await h.call('boss', 'POST', '/api/admin/badges/far-out/retire');
    await h.ctx.db
      .update(badgeDefinitions)
      .set({ origin: 'admin' })
      .where(eq(badgeDefinitions.key, 'show-up'));
    await h.ctx.db
      .update(badgeDefinitions)
      .set({ name: 'Mine' })
      .where(eq(badgeDefinitions.key, 'show-up'));
    await seedBadges(h.ctx);
    const by = async (k: string) =>
      (await h.ctx.db.select().from(badgeDefinitions).where(eq(badgeDefinitions.key, k)))[0]!;
    expect((await by('long-haul')).name).toBe('Marathon Walker');
    expect((await by('far-out')).status).toBe('retired');
    expect((await by('show-up')).name).toBe('Mine');

    // A non-customised builtin whose stored rule differs gets the new rule and a new version.
    await h.ctx.db
      .update(badgeDefinitions)
      .set({ rule: { type: 'lifetime_total', metric: 'steps', tiers: [1] }, name: 'Old name' })
      .where(eq(badgeDefinitions.key, 'iron-tonnage'));
    const changed = await seedBadges(h.ctx);
    await settleBadgeTasks();
    expect(changed).toEqual(['iron-tonnage']);
    const row = await by('iron-tonnage');
    expect(row.version).toBe(2);
    expect(row.name).toBe('Iron Tonnage');
  });

  it('backfills quietly when a builtin is added: no notification, no feed, already seen', async () => {
    await metrics('ann', 'steps', [['2026-09-01', 150_000]]);
    await seedBadges(h.ctx);
    await settleBadgeTasks();
    const rows = await h.ctx.db
      .select()
      .from(userBadges)
      .where(and(eq(userBadges.userId, id('ann')), eq(userBadges.badgeKey, 'long-haul')));
    expect(rows.map((r) => r.tier)).toEqual([1]);
    expect(rows[0]).toMatchObject({ backfilled: true });
    expect(rows[0]!.seenAt).not.toBeNull();
    expect(await notes('ann')).toHaveLength(0);
    expect(await feed('ann')).toHaveLength(0);
    const [ann] = await h.ctx.db
      .select()
      .from(users)
      .where(eq(users.id, id('ann')));
    expect(ann!.badgeXp).toBeGreaterThan(0);
  });
});

async function adminBadge(key: string): Promise<AdminBadge> {
  const all = await h.call<AdminBadge[]>('boss', 'GET', '/api/admin/badges');
  return all.find((b) => b.key === key)!;
}

describe('rule types', () => {
  it('lifetime_total counts tiers and ignores data outside a window', async () => {
    await put('steps', { type: 'lifetime_total', metric: 'steps', tiers: [1000, 5000, 20000] });
    await metrics('ann', 'steps', [
      ['2026-09-01', 600],
      ['2026-09-02', 600],
      ['2026-09-03', 4000],
    ]);
    await check('ann');
    expect(await tiersOf('ann', 'steps')).toEqual([1, 2]);
    expect(await tiersOf('ben', 'steps')).toEqual([]);
  });

  it('best_period reads a day, a Monday-to-Sunday week and a month', async () => {
    await put('day', {
      type: 'best_period',
      metric: 'steps',
      period: 'day',
      tiers: [10000, 30000],
    });
    await put('week', {
      type: 'best_period',
      metric: 'steps',
      period: 'week',
      tiers: [20000, 30000],
    });
    await put('month', { type: 'best_period', metric: 'steps', period: 'month', tiers: [40000] });
    // 2026-09-28 is a Monday; Sept 28-30 + Oct 1-2 span a week and a month boundary.
    await metrics('ann', 'steps', [
      ['2026-09-27', 9000], // Sunday: previous week
      ['2026-09-28', 8000],
      ['2026-09-29', 8000],
      ['2026-09-30', 8000],
      ['2026-10-01', 8000],
    ]);
    await check('ann');
    expect(await tiersOf('ann', 'day')).toEqual([]);
    expect(await tiersOf('ann', 'week')).toEqual([1, 2]);
    expect(await tiersOf('ann', 'month')).toEqual([]); // September has 33000, October 8000
    await metrics('ann', 'steps', [['2026-09-26', 9000]]);
    await check('ann');
    expect(await tiersOf('ann', 'month')).toEqual([1]);
  });

  it('streak is the longest run of consecutive days, today included', async () => {
    await put('streak', { type: 'streak', metric: 'steps', min: 10000, tiers: [3, 5] });
    await metrics('ann', 'steps', [
      ['2026-09-20', 11000],
      ['2026-09-21', 11000],
      ['2026-09-22', 9000], // breaks it
      ['2026-09-30', 12000],
      ['2026-10-01', 12000],
      ['2026-10-02', 12000], // today counts
    ]);
    await check('ann');
    expect(await tiersOf('ann', 'streak')).toEqual([1]);
    const [row] = await h.ctx.db.select().from(userBadges).where(eq(userBadges.badgeKey, 'streak'));
    expect(row!.context).toMatchObject({ date: '2026-10-02' });
  });

  it('count_days counts days over a minimum, optionally only days with a workout in an hour range', async () => {
    await put('days', { type: 'count_days', metric: 'active_minutes', min: 30, tiers: [3, 4] });
    await put('owl', {
      type: 'count_days',
      metric: 'steps',
      min: 500,
      tiers: [2],
      hours: { from: 0, to: 4 },
    });
    await metrics('ann', 'active_minutes', [
      ['2026-09-01', 30],
      ['2026-09-02', 45],
      ['2026-09-03', 29],
      ['2026-09-04', 90],
    ]);
    await metrics(
      'ann',
      'steps',
      days(4).map((d) => [d, 1000] as [string, number]),
    );
    await act('ann', { id: 'a1', date: '2026-09-01', startHour: 2 });
    await act('ann', { id: 'a2', date: '2026-09-02', startHour: 3 });
    await act('ann', { id: 'a3', date: '2026-09-03', startHour: 12 });
    await check('ann');
    expect(await tiersOf('ann', 'days')).toEqual([1]);
    expect(await tiersOf('ann', 'owl')).toEqual([1]);
  });

  it('single_activity takes the biggest one; hours and sport filter; countsManual=false skips typed-in ones', async () => {
    await put('run', {
      type: 'single_activity',
      sport: 'run',
      measure: 'distance_km',
      tiers: [5, 10, 21.1],
    });
    await put('early', {
      type: 'single_activity',
      sport: 'any',
      measure: 'minutes',
      tiers: [30],
      hours: { from: 4, to: 7 },
    });
    await put(
      'real',
      { type: 'single_activity', sport: 'run', measure: 'distance_km', tiers: [5, 40] },
      { countsManual: false },
    );
    await act('ann', { id: 'r1', date: '2026-09-01', distanceKm: 6, startHour: 18 });
    await act('ann', { id: 'r2', date: '2026-09-02', distanceKm: 11, startHour: 6, minutes: 55 });
    await act('ann', { id: 'r3', date: '2026-09-03', distanceKm: 42, sport: 'ride', startHour: 9 });
    await act('ann', { id: 'r4', date: '2026-09-04', distanceKm: 45, manual: true, startHour: 9 });
    await check('ann');
    // The 45 km typed-in run counts for 'run' (all three tiers), the 42 km ride does not.
    expect(await tiersOf('ann', 'run')).toEqual([1, 2, 3]);
    // Only the 06:00 workout is in the 4-7 am range.
    expect(await tiersOf('ann', 'early')).toEqual([1]);
    // Without manual entries the best run is 11 km: bronze only.
    expect(await tiersOf('ann', 'real')).toEqual([1]);
  });

  it('activity_count (with a minimum size) and activity_total', async () => {
    await put('count', {
      type: 'activity_count',
      sport: 'run',
      tiers: [2, 3],
      measure: 'distance_km',
      min: 5,
    });
    await put('total', {
      type: 'activity_total',
      sport: 'ride',
      measure: 'distance_km',
      tiers: [50, 200],
    });
    await act('ann', { id: 'c1', date: '2026-09-01', distanceKm: 5 });
    await act('ann', { id: 'c2', date: '2026-09-02', distanceKm: 8 });
    await act('ann', { id: 'c3', date: '2026-09-03', distanceKm: 4.9 });
    await act('ann', { id: 'c4', date: '2026-09-04', sport: 'ride', distanceKm: 30 });
    await act('ann', { id: 'c5', date: '2026-09-05', sport: 'ride', distanceKm: 30 });
    await check('ann');
    expect(await tiersOf('ann', 'count')).toEqual([1]);
    expect(await tiersOf('ann', 'total')).toEqual([1]);
  });

  it('date_active needs enough steps on that date in any year', async () => {
    await put('ny', { type: 'date_active', month: 1, day: 1, metric: 'steps', min: 1000 });
    await metrics('ann', 'steps', [['2026-01-01', 400]]);
    await metrics('ben', 'steps', [['2025-01-01', 4000]]);
    await check('ann');
    await check('ben');
    expect(await tiersOf('ann', 'ny')).toEqual([]);
    expect(await tiersOf('ben', 'ny')).toEqual([1]);
  });

  it("social events: reactions (others' items only, once each), comments, creating, joining, teams, friends, invites, records", async () => {
    await put('react', { type: 'social', event: 'reactions_sent', tiers: [1, 2] });
    await put('comm', { type: 'social', event: 'comments_sent', tiers: [1] });
    await put('made', { type: 'social', event: 'challenges_created', tiers: [1] });
    await put('joined', { type: 'social', event: 'challenges_joined', tiers: [1] });
    await put('team', { type: 'social', event: 'team_challenges_joined', tiers: [1] });
    await put('friends', { type: 'social', event: 'friends', tiers: [1] });
    await put('invites', { type: 'social', event: 'invite_joins', tiers: [1] });
    await put('records', { type: 'social', event: 'personal_records', tiers: [2] });

    const [mine, theirs1, theirs2] = await h.ctx.db
      .insert(feedEvents)
      .values([
        { actorId: id('ann'), kind: 'personal_record', payload: {} },
        { actorId: id('ben'), kind: 'personal_record', payload: {} },
        { actorId: id('ben'), kind: 'personal_record', payload: {} },
      ])
      .returning();
    await h.call('ann', 'POST', `/api/feed/${mine!.id}/reactions`, { emoji: '🔥' });
    await h.call('ann', 'POST', `/api/feed/${theirs1!.id}/reactions`, { emoji: '🔥' });
    await h.call('ann', 'POST', `/api/feed/${theirs1!.id}/reactions`, { emoji: '👏' });
    await settleBadgeTasks();
    // Own item and a second emoji on the same item don't count: one cheer so far.
    expect(await tiersOf('ann', 'react')).toEqual([1]);
    await h.call('ann', 'POST', `/api/feed/${theirs2!.id}/reactions`, { emoji: '🔥' });
    await h.call('ann', 'POST', `/api/feed/${theirs2!.id}/comments`, { body: 'nice' });
    await settleBadgeTasks();
    expect(await tiersOf('ann', 'react')).toEqual([1, 2]);
    expect(await tiersOf('ann', 'comm')).toEqual([1]);
    // Every social action re-checks all the social rules, so the friendship counts now.
    expect(await tiersOf('ann', 'friends')).toEqual([1]);
    expect(await tiersOf('cat', 'friends')).toEqual([]);

    // A solo challenge counts for nothing; a group one counts for its creator.
    await finished({ who: [['ann', 1, 5]], solo: true });
    await check('ann', 'social');
    expect(await tiersOf('ann', 'made')).toEqual([]);
    const group = await finished({
      who: [
        ['ann', 1, 5],
        ['ben', 2, 4],
      ],
      team: true,
      invitedBy: { ben: 'ann' },
    });
    await check('ann', 'social');
    await check('ben', 'social');
    expect(await tiersOf('ann', 'made')).toEqual([1]);
    expect(await tiersOf('ann', 'joined')).toEqual([]); // she made it
    expect(await tiersOf('ben', 'joined')).toEqual([1]);
    expect(await tiersOf('ann', 'team')).toEqual([1]);
    expect(await tiersOf('ann', 'invites')).toEqual([1]);
    expect(await tiersOf('ben', 'invites')).toEqual([]);
    expect(group.id).toBeTruthy();

    // Personal records: stored bests plus each later beat.
    await h.ctx.db.execute(sql`insert into personal_records (user_id, key, value, date) values
      (${id('ann')}, 'steps_day', 1, '2026-09-01'), (${id('ann')}, 'distance_day', 1, '2026-09-01')`);
    await check('ann');
    expect(await tiersOf('ann', 'records')).toEqual([1]);
  });
});

describe('challenge results', () => {
  it('wins, podiums and field size, never counting solo challenges or empty scores', async () => {
    await put('wins', { type: 'challenge_result', place: 1, tiers: [1, 2] });
    await put('podium', { type: 'challenge_result', place: 3, tiers: [3] });
    await put('big', { type: 'challenge_result', place: 1, minParticipants: 4, tiers: [1] });
    await put('team', { type: 'challenge_result', place: 1, teamOnly: true, tiers: [1] });
    await put('played', { type: 'challenge_result', tiers: [3] });
    await finished({
      who: [
        ['ann', 1, 9],
        ['ben', 2, 5],
      ],
    });
    await finished({
      who: [
        ['ann', 3, 1],
        ['ben', 1, 9],
        ['cat', 2, 5],
      ],
    });
    await finished({ who: [['ann', 1, 1]], solo: true });
    await finished({ who: [['ann', 1, 5]] }); // alone: no field
    await finished({
      who: [
        ['ann', 1, null],
        ['ben', 1, 3],
      ],
    }); // no score: not a result
    await check('ann', 'challenge');
    expect(await tiersOf('ann', 'wins')).toEqual([1]);
    expect(await tiersOf('ann', 'podium')).toEqual([]);
    expect(await tiersOf('ann', 'big')).toEqual([]);
    expect(await tiersOf('ann', 'played')).toEqual([]);
    await finished({
      who: [
        ['ann', 1, 9],
        ['ben', 2, 5],
        ['cat', 3, 4],
        ['boss', 4, 1],
      ],
      team: true,
      name: 'Teams',
    });
    await check('ann', 'challenge');
    expect(await tiersOf('ann', 'wins')).toEqual([1, 2]);
    expect(await tiersOf('ann', 'big')).toEqual([1]);
    expect(await tiersOf('ann', 'team')).toEqual([1]);
    expect(await tiersOf('ann', 'played')).toEqual([1]);
    const [ctxRow] = await h.ctx.db
      .select()
      .from(userBadges)
      .where(and(eq(userBadges.userId, id('ann')), eq(userBadges.badgeKey, 'big')));
    expect(ctxRow!.context).toMatchObject({ challengeName: 'Teams' });
  });

  it('drama: comeback, photo finish, wire to wire and giant killer', async () => {
    for (const d of ['comeback', 'photo_finish', 'wire_to_wire', 'giant_killer'] as const)
      await put(d, { type: 'challenge_result', drama: d, tiers: [1] });

    // Comeback: last of three at the halfway day (Sept 5), then first.
    const a = await finished({
      who: [
        ['ann', 1, 100],
        ['ben', 2, 90],
        ['cat', 3, 80],
      ],
    });
    await h.ctx.db.insert(rankSnapshots).values([
      { challengeId: a.id, userId: id('ann'), date: '2026-09-05', rank: 3 },
      { challengeId: a.id, userId: id('ben'), date: '2026-09-05', rank: 1 },
      { challengeId: a.id, userId: id('cat'), date: '2026-09-05', rank: 2 },
      { challengeId: a.id, userId: id('ann'), date: '2026-09-09', rank: 1 },
    ]);
    // Photo finish: 10,000 vs 9,950 (0.5%).
    await finished({
      who: [
        ['ann', 1, 10000],
        ['ben', 2, 9950],
      ],
      start: '2026-08-01',
      end: '2026-08-05',
    });
    // Wire to wire: first on every daily snapshot.
    const w = await finished({
      who: [
        ['ann', 1, 50],
        ['ben', 2, 10],
      ],
      start: '2026-07-01',
      end: '2026-07-05',
    });
    await h.ctx.db.insert(rankSnapshots).values(
      ['2026-07-02', '2026-07-03', '2026-07-04'].flatMap((date) => [
        { challengeId: w.id, userId: id('ann'), date, rank: 1 },
        { challengeId: w.id, userId: id('ben'), date, rank: 2 },
      ]),
    );
    // Giant killer: ben usually walks 4x what ann does, and she beat him.
    await finished({
      who: [
        ['ann', 1, 500],
        ['ben', 2, 400],
      ],
      start: '2026-05-01',
      end: '2026-05-05',
    });
    await metrics(
      'ann',
      'steps',
      days(30, '2026-04-01').map((d) => [d, 1000] as [string, number]),
    );
    await metrics(
      'ben',
      'steps',
      days(30, '2026-04-01').map((d) => [d, 4000] as [string, number]),
    );
    await check('ann', 'challenge');
    for (const d of ['comeback', 'photo_finish', 'wire_to_wire', 'giant_killer'])
      expect(await tiersOf('ann', d), d).toEqual([1]);
    // And not for the people who lost.
    await check('ben', 'challenge');
    for (const d of ['comeback', 'photo_finish', 'wire_to_wire'])
      expect(await tiersOf('ben', d), d).toEqual([]);
  });

  it('drama near-misses do not earn: a 2% win, a win that was never last, a 2x opponent', async () => {
    for (const d of ['comeback', 'photo_finish', 'giant_killer'] as const)
      await put(d, { type: 'challenge_result', drama: d, tiers: [1] });
    await finished({
      who: [
        ['ann', 1, 10000],
        ['ben', 2, 9800],
      ],
      start: '2026-08-01',
      end: '2026-08-05',
    });
    const a = await finished({
      who: [
        ['ann', 1, 100],
        ['ben', 2, 90],
        ['cat', 3, 80],
      ],
    });
    await h.ctx.db.insert(rankSnapshots).values([
      { challengeId: a.id, userId: id('ann'), date: '2026-09-05', rank: 2 },
      { challengeId: a.id, userId: id('ben'), date: '2026-09-05', rank: 1 },
      { challengeId: a.id, userId: id('cat'), date: '2026-09-05', rank: 3 },
    ]);
    await finished({
      who: [
        ['ann', 1, 500],
        ['ben', 2, 400],
      ],
      start: '2026-05-01',
      end: '2026-05-05',
    });
    await metrics(
      'ann',
      'steps',
      days(30, '2026-04-01').map((d) => [d, 1000] as [string, number]),
    );
    await metrics(
      'ben',
      'steps',
      days(30, '2026-04-01').map((d) => [d, 2000] as [string, number]),
    );
    await check('ann', 'challenge');
    for (const d of ['comeback', 'photo_finish', 'giant_killer'])
      expect(await tiersOf('ann', d), d).toEqual([]);
  });

  it('rivalry: rematches won and side bets paid', async () => {
    await put('rematch', { type: 'social', event: 'rematches_won', tiers: [1] });
    await put('paid', { type: 'social', event: 'stakes_paid', tiers: [1] });
    await finished({
      who: [
        ['ann', 1, 9],
        ['ben', 2, 5],
      ],
      rematch: true,
    });
    // Ben lost and settled up; Ann didn't lose anything.
    await finished({
      who: [
        ['ann', 1, 9],
        ['ben', 2, 5],
      ],
      stake: true,
      settled: true,
      name: 'Bet',
    });
    await finished({
      who: [
        ['ann', 2, 1],
        ['ben', 1, 5],
      ],
      stake: true,
      name: 'Unsettled',
    });
    await check('ann', 'challenge');
    await check('ben', 'challenge');
    expect(await tiersOf('ann', 'rematch')).toEqual([1]);
    expect(await tiersOf('ben', 'rematch')).toEqual([]);
    expect(await tiersOf('ben', 'paid')).toEqual([1]);
    expect(await tiersOf('ann', 'paid')).toEqual([]);
  });

  it('finalizing a real challenge checks everyone in it', async () => {
    await put('win', { type: 'challenge_result', place: 1, tiers: [1] });
    const [ch] = await h.ctx.db
      .insert(challenges)
      .values({
        name: 'Real one',
        metric: 'steps',
        aggregate: 'sum',
        scoring: 'total',
        startDate: '2026-09-01',
        endDate: '2026-09-03',
        timezone: 'UTC',
        createdBy: id('ann'),
      })
      .returning();
    await h.ctx.db.insert(challengeParticipants).values(
      ['ann', 'ben'].map((w) => ({
        challengeId: ch!.id,
        userId: id(w),
        state: 'joined' as const,
      })),
    );
    await metrics('ann', 'steps', [['2026-09-01', 9000]]);
    await metrics('ben', 'steps', [['2026-09-01', 1000]]);
    expect(await finalizeChallenge(h.ctx, ch!)).toBe(true);
    expect(await tiersOf('ann', 'win')).toEqual([1]);
    expect(await tiersOf('ben', 'win')).toEqual([]);
    expect((await notes('ann')).map((n) => n.body)).toContain('You earned Badge win');
  });
});

describe('windows', () => {
  const window = { windowStart: '2026-10-01', windowEnd: '2026-10-31' };
  it('counts only data inside the window, and only while it is open', async () => {
    await put('oct', { type: 'lifetime_total', metric: 'steps', tiers: [1000] }, window);
    await metrics('ann', 'steps', [['2026-09-30', 5000]]); // before the window
    await check('ann');
    expect(await tiersOf('ann', 'oct')).toEqual([]);
    await metrics('ann', 'steps', [['2026-10-02', 1500]]);
    await check('ann');
    expect(await tiersOf('ann', 'oct')).toEqual([1]);
  });
  it('cannot be earned before it starts or after it ends', async () => {
    await put(
      'later',
      { type: 'lifetime_total', metric: 'steps', tiers: [1] },
      { windowStart: '2026-11-01', windowEnd: '2026-11-30' },
    );
    await put(
      'past',
      { type: 'lifetime_total', metric: 'steps', tiers: [1] },
      { windowStart: '2026-08-01', windowEnd: '2026-08-31' },
    );
    await metrics('ann', 'steps', [
      ['2026-08-15', 5000],
      ['2026-11-05', 5000],
    ]);
    await check('ann');
    expect(await tiersOf('ann', 'later')).toEqual([]);
    expect(await tiersOf('ann', 'past')).toEqual([]);
    // The day after it ends still counts (late syncs); later than that doesn't.
    await put(
      'edge',
      { type: 'lifetime_total', metric: 'steps', tiers: [1] },
      { windowStart: '2026-09-01', windowEnd: '2026-10-01' },
    );
    await metrics('ann', 'steps', [['2026-10-01', 10]]);
    await check('ann');
    expect(await tiersOf('ann', 'edge')).toEqual([1]);
  });
});

describe('the engine', () => {
  it('is idempotent: a second check adds nothing and says nothing', async () => {
    await put('steps', { type: 'lifetime_total', metric: 'steps', tiers: [100, 200] });
    await metrics('ann', 'steps', [['2026-09-01', 150]]);
    const first = await check('ann');
    expect(first).toEqual([{ key: 'steps', tier: 1 }]);
    expect(await check('ann')).toEqual([]);
    await Promise.all([check('ann'), check('ann'), check('ann', 'social')]);
    expect(await tiersOf('ann', 'steps')).toEqual([1]);
    expect(await notes('ann')).toHaveLength(1);
    // Moving up again only announces the new tier.
    await metrics('ann', 'steps', [['2026-09-02', 150]]);
    expect(await check('ann')).toEqual([{ key: 'steps', tier: 2 }]);
    expect(await notes('ann')).toHaveLength(2);
  });

  it('groups one check into one notification, worded by tier', async () => {
    await put(
      'a',
      { type: 'lifetime_total', metric: 'steps', tiers: [100, 200, 300] },
      { name: 'Million Stepper' },
    );
    await put('b', { type: 'lifetime_total', metric: 'distance', tiers: [1] }, { name: 'Far' });
    await put('c', { type: 'lifetime_total', metric: 'workouts', tiers: [1] }, { name: 'Show' });
    await metrics('ann', 'steps', [['2026-09-01', 250]]);
    await check('ann');
    let n = await notes('ann');
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ body: 'You earned Silver · Million Stepper', url: '/badges' });
    await metrics('ann', 'steps', [['2026-09-01', 400]]);
    await metrics('ann', 'distance', [['2026-09-01', 5]]);
    await metrics('ann', 'workouts', [['2026-09-01', 5]]);
    await check('ann');
    n = await notes('ann');
    expect(n).toHaveLength(2);
    expect(n[0]!.body).toBe('You earned 3 badges');
  });

  it('posts to the feed only for gold, platinum, single-tier secret and limited-time badges', async () => {
    await put('bronze', { type: 'lifetime_total', metric: 'steps', tiers: [100, 200, 300, 400] });
    await metrics('ann', 'steps', [['2026-09-01', 150]]);
    await check('ann');
    expect(await feed('ann')).toHaveLength(0);

    await metrics('ann', 'steps', [['2026-09-01', 350]]);
    await check('ann');
    const gold = await feed('ben'); // friends see it
    expect(gold).toHaveLength(1);
    expect(gold[0]).toMatchObject({
      actor: { id: id('ann') },
      badgeEarned: { key: 'bronze', tier: 3, tierName: 'gold', more: 0 },
    });
    expect(gold[0]!.text).toContain('Gold · Badge bronze');

    await put(
      'shh',
      { type: 'lifetime_total', metric: 'distance', tiers: [1] },
      { secret: true, name: 'Shh' },
    );
    await put(
      'limited',
      { type: 'lifetime_total', metric: 'workouts', tiers: [1] },
      { windowStart: '2026-10-01', windowEnd: '2026-10-31' },
    );
    await put('plain', { type: 'lifetime_total', metric: 'water', tiers: [1] });
    await metrics('ann', 'distance', [['2026-09-02', 5]]);
    await metrics('ann', 'workouts', [['2026-10-02', 1]]);
    await metrics('ann', 'water', [['2026-10-02', 1]]);
    await check('ann');
    const all = await feed('ann');
    // One feed post for the check, the highest-value standout, mentioning the others.
    expect(all).toHaveLength(2);
    const newest = all[0]!;
    expect(newest.badgeEarned!.more).toBe(2);
    expect(['shh', 'limited']).toContain(newest.badgeEarned!.key);
  });

  it('the first ever check is a backfill: quiet rows and one summary notification', async () => {
    await put('a', { type: 'lifetime_total', metric: 'steps', tiers: [100, 200] });
    await put('b', { type: 'lifetime_total', metric: 'distance', tiers: [1] });
    await h.ctx.db.delete(serverState).where(eq(serverState.key, `badge_init:${id('cat')}`));
    await metrics('cat', 'steps', [['2026-09-01', 500]]);
    await metrics('cat', 'distance', [['2026-09-01', 5]]);
    await check('cat');
    const rows = await h.ctx.db
      .select()
      .from(userBadges)
      .where(eq(userBadges.userId, id('cat')));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.backfilled && r.seenAt)).toBe(true);
    const n = await notes('cat');
    expect(n).toHaveLength(1);
    expect(n[0]!.body).toBe("You've unlocked 2 badges — take a look");
    expect(await feed('cat')).toHaveLength(0);
    // After that, new tiers are celebrated normally.
    await metrics('cat', 'distance', [['2026-09-01', 5]]);
    await put('c', { type: 'lifetime_total', metric: 'workouts', tiers: [1] });
    await metrics('cat', 'workouts', [['2026-09-01', 1]]);
    await check('cat');
    expect((await notes('cat')).map((x) => x.body)).toContain('You earned Badge c');
  });

  it('only checks the rules a trigger can have changed', async () => {
    await put('steps', { type: 'lifetime_total', metric: 'steps', tiers: [1] });
    await put('social', { type: 'social', event: 'friends', tiers: [1] });
    await metrics('ann', 'steps', [['2026-09-01', 5]]);
    expect(await check('ann', 'social')).toEqual([{ key: 'social', tier: 1 }]);
    expect(await check('ann', 'challenge')).toEqual([]);
    expect(await check('ann', 'sync')).toEqual([{ key: 'steps', tier: 1 }]);
  });

  it('keeps a retired badge, and its XP, but stops awarding it', async () => {
    await put(
      'old',
      { type: 'lifetime_total', metric: 'steps', tiers: [100, 200] },
      { xp: [20, 40] },
    );
    await metrics('ann', 'steps', [['2026-09-01', 150]]);
    await check('ann');
    const xp = async () =>
      (
        await h.ctx.db
          .select()
          .from(users)
          .where(eq(users.id, id('ann')))
      )[0]!.badgeXp;
    expect(await xp()).toBe(20);
    await h.call('boss', 'POST', '/api/admin/badges/old/retire');
    await metrics('ann', 'steps', [['2026-09-02', 500]]);
    await check('ann');
    expect(await tiersOf('ann', 'old')).toEqual([1]); // retired: no tier 2
    expect(await xp()).toBe(20);
    const cat = await h.call<BadgeCatalogResponse>('ann', 'GET', '/api/badges');
    expect(cat.badges.find((b) => b.key === 'old')).toMatchObject({ status: 'retired', tier: 1 });
    const ben = await h.call<BadgeCatalogResponse>('ben', 'GET', '/api/badges');
    expect(ben.badges.find((b) => b.key === 'old')).toBeUndefined();
    // Even if the badge is later edited, earned rows stay.
    expect(await tiersOf('ann', 'old')).toEqual([1]);
  });

  it('demo accounts never earn live, but have a fixed sample set', async () => {
    await seedBadges(h.ctx);
    await settleBadgeTasks();
    await refreshDemo(h.ctx);
    const demo = (await findDemoUser(h.ctx))!;
    const before = await h.ctx.db.select().from(userBadges).where(eq(userBadges.userId, demo.id));
    expect(before.length).toBeGreaterThan(5);
    const [u] = await h.ctx.db.select().from(users).where(eq(users.id, demo.id));
    expect(u!.badgeXp).toBeGreaterThan(0);
    await h.ctx.db
      .update(dailyMetrics)
      .set({ value: 50_000_000 })
      .where(and(eq(dailyMetrics.userId, demo.id), eq(dailyMetrics.metric, 'steps')));
    expect(await checkBadges(h.ctx, demo.id, { reason: 'sync' })).toEqual([]);
    expect(
      await h.ctx.db.select().from(userBadges).where(eq(userBadges.userId, demo.id)),
    ).toHaveLength(before.length);
    expect(await notes('ann')).toHaveLength(0);
  });
});

describe('sync stores workouts as activities', () => {
  it('upserts summaries with sport, hour and manual, and removes ones that went away', async () => {
    const ann = h.sparky.ann!;
    ann.exerciseEntries = [
      {
        id: 'e1',
        entry_date: '2026-10-01',
        exercise_name: 'Morning Run',
        duration_minutes: 40,
        calories_burned: 400,
        exercise_source: 'garmin',
        distance: 7.5,
        start_time: '2026-10-01T05:30:00Z',
      },
      {
        id: 'e2',
        entry_date: '2026-10-01',
        exercise_name: 'Yoga',
        duration_minutes: 30,
        calories_burned: 100,
        exercise_source: 'manual',
        entry_time: '19:15:00',
      },
      {
        entry_date: '2026-10-02',
        exercise_name: 'Squat',
        exercise_source: 'liftosaur',
        sets: [{ set_type: 'Working Set', reps: 5, weight: 100 }],
      },
    ];
    await syncUser(h.ctx, id('ann'));
    const rows = await h.ctx.db
      .select()
      .from(activities)
      .where(eq(activities.userId, id('ann')));
    const by = Object.fromEntries(rows.map((r) => [r.name.toLowerCase().split(' ')[0]!, r]));
    expect(rows).toHaveLength(3);
    expect(by.morning).toMatchObject({
      sport: 'run',
      startHour: 5,
      distanceKm: 7.5,
      manual: false,
    });
    expect(by.yoga).toMatchObject({ sport: 'yoga', startHour: 19, manual: true });
    expect(by.squat).toMatchObject({ sport: 'strength' });
    // A workout deleted in SparkyFitness disappears.
    ann.exerciseEntries = ann.exerciseEntries.slice(0, 1);
    await syncUser(h.ctx, id('ann'));
    expect(
      await h.ctx.db
        .select()
        .from(activities)
        .where(eq(activities.userId, id('ann'))),
    ).toHaveLength(1);
    // A sync checks badges too.
    await put('km', { type: 'single_activity', sport: 'run', measure: 'distance_km', tiers: [5] });
    await syncUser(h.ctx, id('ann'));
    expect(await tiersOf('ann', 'km')).toEqual([1]);
  });
});

describe('admin and API', () => {
  const draft = (key: string, extra: Partial<BadgeDraft> = {}): BadgeDraft => ({
    key,
    name: 'Draft badge',
    description: 'Walk {n} steps.',
    family: 'movement',
    icon: 'shoe',
    imageUrl: null,
    secret: false,
    rule: { type: 'lifetime_total', metric: 'steps', tiers: [100, 1000] },
    window: null,
    xp: null,
    countsManual: true,
    ...extra,
  });

  it('is admin only', async () => {
    for (const [method, url] of [
      ['GET', '/api/admin/badges'],
      ['POST', '/api/admin/badges'],
      ['POST', '/api/admin/badges/preview'],
      ['POST', '/api/admin/badges/images'],
      ['PUT', '/api/admin/badges/x-y'],
      ['POST', '/api/admin/badges/x-y/publish'],
      ['POST', '/api/admin/badges/x-y/retire'],
      ['DELETE', '/api/admin/badges/x-y'],
    ] as const) {
      expect((await h.raw('ann', method, url, draft('x-y'))).statusCode, `${method} ${url}`).toBe(
        403,
      );
      expect((await h.raw(null, method, url, draft('x-y'))).statusCode, `${method} ${url}`).toBe(
        401,
      );
    }
  });

  it('creates a draft, edits it, publishes (quiet backfill), retires, and only deletes drafts', async () => {
    await metrics('ann', 'steps', [['2026-09-01', 500]]);
    const made = await h.call<AdminBadge>('boss', 'POST', '/api/admin/badges', draft('walker'));
    expect(made).toMatchObject({ status: 'draft', origin: 'admin', version: 1, earnedBy: 0 });
    expect((await h.raw('boss', 'POST', '/api/admin/badges', draft('walker'))).statusCode).toBe(
      409,
    );
    expect(
      (
        await h.raw('boss', 'POST', '/api/admin/badges', {
          ...draft('bad-one'),
          rule: { type: 'nope' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await h.raw(
          'boss',
          'POST',
          '/api/admin/badges',
          draft('ext-img', { imageUrl: 'https://evil.example/x.png' }),
        )
      ).statusCode,
    ).toBe(400);
    // Drafts aren't shown to people, or awarded.
    await check('ann');
    expect(await tiersOf('ann', 'walker')).toEqual([]);
    expect(
      (await h.call<BadgeCatalogResponse>('ann', 'GET', '/api/badges')).badges.map((b) => b.key),
    ).not.toContain('walker');

    const edited = await h.call<AdminBadge>(
      'boss',
      'PUT',
      '/api/admin/badges/walker',
      draft('other-key', { name: 'Walker' }),
    );
    expect(edited).toMatchObject({ key: 'walker', name: 'Walker', version: 1 });

    const pub = await h.call<AdminBadge>('boss', 'POST', '/api/admin/badges/walker/publish');
    expect(pub).toMatchObject({ status: 'live' });
    expect(pub.publishedAt).toBeTruthy();
    await settleBadgeTasks();
    expect(await tiersOf('ann', 'walker')).toEqual([1]);
    const row = (
      await h.ctx.db.select().from(userBadges).where(eq(userBadges.badgeKey, 'walker'))
    )[0]!;
    expect(row).toMatchObject({ backfilled: true });
    expect(await notes('ann')).toHaveLength(0);
    expect((await adminBadge('walker')).earnedBy).toBe(1);

    expect((await h.raw('boss', 'DELETE', '/api/admin/badges/walker')).statusCode).toBe(409);
    await h.call('boss', 'POST', '/api/admin/badges/walker/retire');
    expect((await adminBadge('walker')).status).toBe('retired');
    await h.call('boss', 'POST', '/api/admin/badges', draft('scrap'));
    expect((await h.raw('boss', 'DELETE', '/api/admin/badges/scrap')).statusCode).toBe(204);
    expect((await h.raw('boss', 'POST', '/api/admin/badges/nope/publish')).statusCode).toBe(404);
  });

  it('editing the rule of a live badge bumps its version and re-runs the backfill; wording does not', async () => {
    await metrics('ann', 'steps', [['2026-09-01', 500]]);
    await h.call('boss', 'POST', '/api/admin/badges', draft('grow'));
    await h.call('boss', 'POST', '/api/admin/badges/grow/publish');
    await settleBadgeTasks();
    expect(await tiersOf('ann', 'grow')).toEqual([1]);
    const rename = await h.call<AdminBadge>(
      'boss',
      'PUT',
      '/api/admin/badges/grow',
      draft('grow', { name: 'Grower' }),
    );
    expect(rename.version).toBe(1);
    const harder = await h.call<AdminBadge>(
      'boss',
      'PUT',
      '/api/admin/badges/grow',
      draft('grow', {
        rule: { type: 'lifetime_total', metric: 'steps', tiers: [50, 400, 100000] },
      }),
    );
    expect(harder.version).toBe(2);
    await settleBadgeTasks();
    // Everyone keeps tier 1, and now also qualifies for the new tier 2.
    expect(await tiersOf('ann', 'grow')).toEqual([1, 2]);
    const rows = await h.ctx.db
      .select()
      .from(userBadges)
      .where(and(eq(userBadges.userId, id('ann')), eq(userBadges.badgeKey, 'grow')));
    expect(rows.find((r) => r.tier === 2)!.version).toBe(2);
    // A built-in that is edited stops following the seed.
    await seedBadges(h.ctx);
    await h.call('boss', 'PUT', '/api/admin/badges/never-miss', {
      ...(await adminBadge('never-miss')),
      name: 'Streaker',
    });
    expect(
      (
        await h.ctx.db.select().from(badgeDefinitions).where(eq(badgeDefinitions.key, 'never-miss'))
      )[0]!.customized,
    ).toBe(true);
  });

  it('previews who would earn without writing anything', async () => {
    await metrics('ann', 'steps', [['2026-09-01', 5000]]);
    await metrics('ben', 'steps', [['2026-09-01', 150]]);
    const p = await h.call<BadgePreviewResponse>(
      'boss',
      'POST',
      '/api/admin/badges/preview',
      draft('preview-me'),
    );
    expect(p.wouldEarn).toBe(2);
    expect(p.byTier).toEqual([2, 1]);
    expect(p.sample[0]).toMatchObject({ tier: 2, user: { id: id('ann') } });
    expect(await h.ctx.db.select().from(badgeDefinitions)).toHaveLength(0);
    expect(await h.ctx.db.select().from(userBadges)).toHaveLength(0);
    expect(await notes('ann')).toHaveLength(0);
  });

  it('images: validates type, size and SVG contents; serves them locked down', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(40)]);
    const up = await h.raw('boss', 'POST', '/api/admin/badges/images', {
      mime: 'image/png',
      data: png.toString('base64'),
    });
    expect(up.statusCode).toBe(201);
    const { url } = up.json() as { url: string };
    expect(url).toMatch(/^\/api\/badge-images\/[0-9a-f-]{36}$/);
    const img = await h.raw(null, 'GET', url);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(img.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(String(img.headers['cache-control'])).toContain('immutable');

    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';
    expect(
      (
        await h.raw('boss', 'POST', '/api/admin/badges/images', {
          mime: 'image/svg+xml',
          data: Buffer.from(svg).toString('base64'),
        })
      ).statusCode,
    ).toBe(201);
    for (const bad of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>',
    ])
      expect(
        (
          await h.raw('boss', 'POST', '/api/admin/badges/images', {
            mime: 'image/svg+xml',
            data: Buffer.from(bad).toString('base64'),
          })
        ).statusCode,
        bad,
      ).toBe(400);
    // Wrong type, wrong bytes, too big.
    expect(
      (
        await h.raw('boss', 'POST', '/api/admin/badges/images', {
          mime: 'image/gif',
          data: png.toString('base64'),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await h.raw('boss', 'POST', '/api/admin/badges/images', {
          mime: 'image/png',
          data: Buffer.from('not a png').toString('base64'),
        })
      ).statusCode,
    ).toBe(400);
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(300 * 1024)]);
    expect(
      (
        await h.raw('boss', 'POST', '/api/admin/badges/images', {
          mime: 'image/png',
          data: big.toString('base64'),
        })
      ).statusCode,
    ).toBe(400);
    // Raw bytes work too.
    const rawUp = await h.raw('boss', 'POST', '/api/admin/badges/images', png as never, {
      'content-type': 'image/png',
    });
    expect(rawUp.statusCode).toBe(201);
    expect((await h.raw(null, 'GET', '/api/badge-images/not-an-id')).statusCode).toBe(404);
    // A draft can use the uploaded image.
    const made = await h.call<AdminBadge>(
      'boss',
      'POST',
      '/api/admin/badges',
      draft('pic', { imageUrl: url }),
    );
    expect(made.imageUrl).toBe(url);
  });

  it('shows my catalog with progress and labels in my units; secrets stay hidden until earned', async () => {
    await put(
      'far',
      { type: 'lifetime_total', metric: 'distance', tiers: [100, 1000] },
      { description: 'Cover {n} in total.' },
    );
    await put(
      'secret',
      { type: 'lifetime_total', metric: 'workouts', tiers: [1] },
      { secret: true, name: 'Hidden gem', description: 'Secret doing' },
    );
    await metrics('ann', 'distance', [['2026-09-01', 40]]);
    await h
      .call('ben', 'PUT', '/api/me', { settings: { units: 'imperial' } })
      .catch(() => undefined);
    await h.ctx.db
      .update(users)
      .set({ displayUnits: 'imperial' })
      .where(eq(users.id, id('ben')));
    const mine = await h.call<BadgeCatalogResponse>('ann', 'GET', '/api/badges');
    const far = mine.badges.find((b) => b.key === 'far')!;
    expect(far.tiers[0]!.label).toBe('Cover 100 km in total.');
    expect(far.progress).toMatchObject({ value: 40, target: 100 });
    expect(far.progress!.label).toBe('40 km of 100 km');
    const hidden = mine.badges.find((b) => b.key === 'secret')!;
    expect(hidden).toMatchObject({ hidden: true, name: '?', tiers: [], progress: null });
    expect(JSON.stringify(hidden)).not.toContain('Hidden gem');
    const theirs = await h.call<BadgeCatalogResponse>('ben', 'GET', '/api/badges');
    expect(theirs.badges.find((b) => b.key === 'far')!.tiers[0]!.label).toBe(
      'Cover 62.1 mi in total.',
    );
    expect(theirs.level.level).toBe(1);

    await metrics('ann', 'workouts', [['2026-09-01', 1]]);
    await check('ann');
    const after = await h.call<BadgeCatalogResponse>('ann', 'GET', '/api/badges');
    expect(after.badges.find((b) => b.key === 'secret')).toMatchObject({
      hidden: false,
      name: 'Hidden gem',
      tier: 1,
    });
    expect(after.earnedCount).toBe(1);
  });

  it('unseen, seen, detail and showcase', async () => {
    await put('s1', { type: 'lifetime_total', metric: 'steps', tiers: [1, 2] });
    await put('s2', { type: 'lifetime_total', metric: 'distance', tiers: [1] });
    await metrics('ann', 'steps', [['2026-09-01', 5]]);
    await metrics('ann', 'distance', [['2026-09-01', 5]]);
    await check('ann');
    const unseen = await h.call<UnseenBadgesResponse>('ann', 'GET', '/api/badges/unseen');
    expect(unseen.badges.map((b) => b.key).sort()).toEqual(['s1', 's2']);
    expect(unseen.level.xp).toBeGreaterThan(0);
    expect(
      (await h.call<BadgeCatalogResponse>('ann', 'GET', '/api/badges')).badges.find(
        (b) => b.key === 's1',
      )!.unseen,
    ).toBe(true);
    await h.call('ann', 'POST', '/api/badges/seen', { keys: ['s1'] });
    expect(
      (await h.call<UnseenBadgesResponse>('ann', 'GET', '/api/badges/unseen')).badges.map(
        (b) => b.key,
      ),
    ).toEqual(['s2']);

    const detail = await h.call<BadgeDetailResponse>('ann', 'GET', '/api/badges/s1');
    expect(detail.history).toHaveLength(2);
    expect(detail).toMatchObject({ earnedByCount: 1, friendsWithIt: 0 });
    expect((await h.call<BadgeDetailResponse>('ben', 'GET', '/api/badges/s1')).friendsWithIt).toBe(
      1,
    );
    expect((await h.raw('ann', 'GET', '/api/badges/nope')).statusCode).toBe(404);

    // Showcase: only earned keys, at most three, not an unknown key.
    await put('s3', { type: 'lifetime_total', metric: 'water', tiers: [1] });
    expect((await h.raw('ann', 'PUT', '/api/me/showcase', { keys: ['s1', 's3'] })).statusCode).toBe(
      400,
    );
    expect(
      (await h.raw('ann', 'PUT', '/api/me/showcase', { keys: ['s1', 's2', 'x', 'y'] })).statusCode,
    ).toBe(400);
    expect((await h.raw('ann', 'PUT', '/api/me/showcase', { keys: ['nope'] })).statusCode).toBe(
      400,
    );
    expect(await h.call('ann', 'PUT', '/api/me/showcase', { keys: ['s2', 's1'] })).toEqual({
      showcase: ['s2', 's1'],
    });
    expect((await h.call<BadgeCatalogResponse>('ann', 'GET', '/api/badges')).showcase).toEqual([
      's2',
      's1',
    ]);
  });

  it("someone else's badges follow profile privacy: visible only when they share stats", async () => {
    await put('s1', { type: 'lifetime_total', metric: 'steps', tiers: [1] });
    await metrics('ann', 'steps', [['2026-09-01', 5]]);
    await check('ann');
    // ben is ann's friend, cat is a stranger; ann hasn't shared her stats.
    expect((await h.raw('ben', 'GET', `/api/users/${id('ann')}/badges`)).statusCode).toBe(404);
    await h.ctx.db
      .update(users)
      .set({ shareProfileStats: true })
      .where(eq(users.id, id('ann')));
    const seen = await h.call<BadgeCatalogResponse>('ben', 'GET', `/api/users/${id('ann')}/badges`);
    expect(seen.badges.find((b) => b.key === 's1')).toMatchObject({ tier: 1 });
    expect(seen.badges.find((b) => b.key === 's1')!.progress).toBeNull();
    expect(seen.user.id).toBe(id('ann'));
    expect((await h.raw('cat', 'GET', `/api/users/${id('ann')}/badges`)).statusCode).toBe(404); // can't see her at all
    await h.ctx.db
      .update(users)
      .set({ visibility: 'public' })
      .where(eq(users.id, id('ann')));
    expect((await h.raw('cat', 'GET', `/api/users/${id('ann')}/badges`)).statusCode).toBe(200);
    expect((await h.raw('cat', 'GET', `/api/users/not-a-uuid/badges`)).statusCode).toBe(404);
    expect((await h.raw('ben', 'GET', `/api/badges/s1?user=${id('ann')}`)).statusCode).toBe(200);
    await h.ctx.db
      .update(users)
      .set({ visibility: 'private' })
      .where(eq(users.id, id('ann')));
  });

  it('cards carry the level', async () => {
    await h.ctx.db
      .update(users)
      .set({ badgeXp: 400 })
      .where(eq(users.id, id('ann')));
    const friends = await h.call<{ friends: { id: string; level?: number }[] }>(
      'ben',
      'GET',
      '/api/friends',
    );
    expect(friends.friends.find((f) => f.id === id('ann'))!.level).toBeGreaterThan(1);
    const me = await h.call<{ level?: number }>('ann', 'GET', '/api/me');
    expect(me.level).toBeGreaterThan(1);
  });
});
