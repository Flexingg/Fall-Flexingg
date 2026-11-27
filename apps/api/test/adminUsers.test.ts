/**
 * Admin accounts: activity tracking, listing/filters, scheduling and deleting accounts (with the
 * guards), the sweep, cleanup of expired accounts, created-challenge handling, no secret leaks,
 * the challenges overview and read-only admin viewing, and "publish all" badges.
 */
import type {
  AdminChallengesResponse,
  AdminUserDetail,
  AdminUsersResponse,
  AppNotification,
  BadgeBackfillStatus,
  CleanupResult,
  NotificationsPage,
  MeUser,
} from '@gauntlet/shared';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  badgeDefinitions,
  challengeParticipants,
  challenges,
  pushTargets,
  serverState,
  users,
} from '../src/db/schema.js';
import { settleActivity, touchActive } from '../src/services/activity.js';
import { cleanupExpired, sweepScheduledDeletions } from '../src/services/adminUsers.js';
import { settleBadgeTasks } from '../src/services/badges/tasks.js';
import { runSyncCycle } from '../src/scheduler.js';
import { syncUser } from '../src/services/sync.js';
import { setup, type Harness } from './notifyHarness.js';

let h: Harness;
const NAMES = ['boss', 'other', 'ann', 'ben', 'cat', 'dan'];
const id = (n: string) => h.ids[n]!;
const DAY = 86_400_000;
const NOW = '2026-10-02T18:00:00Z';
const ago = (days: number) => new Date(new Date(NOW).getTime() - days * DAY);

beforeAll(async () => {
  h = await setup(NAMES, {
    env: { ADMIN_EMAILS: 'boss@example.com,other@example.com', DEMO_ACCOUNT: 'true' },
  });
});
afterAll(() => h.close());

/** Tests delete people; add them back (as fresh accounts) so every test starts with the same cast. */
async function restoreCast() {
  for (const n of NAMES) {
    const [u] = await h.ctx.db.select().from(users).where(eq(users.id, h.ids[n]!));
    if (u) continue;
    const [fresh] = await h.ctx.db
      .insert(users)
      .values({
        sparkyUserId: `u-${n}-${randomUUID()}`,
        email: `${n}@example.com`,
        displayName: n,
      })
      .returning({ id: users.id });
    h.ids[n] = fresh!.id;
  }
}

beforeEach(async () => {
  await restoreCast();
  await settleActivity();
  await settleBadgeTasks();
  h.setClock(NOW);
  await h.ctx.db.execute(
    sql`delete from challenges; delete from notifications; delete from server_state where key like 'admin_%'`,
  );
  await h.ctx.db
    .update(users)
    .set({
      lastActiveAt: ago(1),
      lastSyncedAt: ago(1),
      lastSyncError: null,
      keyStatus: 'active',
      deletionScheduledAt: null,
      deletionReason: null,
    })
    .where(eq(users.isDemo, false));
});

const set = async (who: string, patch: Partial<typeof users.$inferInsert>) => {
  await settleActivity();
  await h.ctx.db
    .update(users)
    .set(patch)
    .where(eq(users.id, id(who)));
};
const row = async (who: string) =>
  (
    await h.ctx.db
      .select()
      .from(users)
      .where(eq(users.id, id(who)))
  )[0];

describe('activity tracking', () => {
  it('stamps on a signed-in request, at most every 10 minutes', async () => {
    await set('ann', { lastActiveAt: ago(3) });
    await h.call('ann', 'GET', '/api/me');
    await settleActivity();
    expect((await row('ann'))!.lastActiveAt!.toISOString()).toBe(new Date(NOW).toISOString());

    h.setClock('2026-10-02T18:05:00Z');
    await h.call('ann', 'GET', '/api/me');
    await settleActivity();
    expect((await row('ann'))!.lastActiveAt!.toISOString()).toBe(new Date(NOW).toISOString());

    h.setClock('2026-10-02T18:11:00Z');
    await h.call('ann', 'GET', '/api/me');
    await settleActivity();
    expect((await row('ann'))!.lastActiveAt!.toISOString()).toBe('2026-10-02T18:11:00.000Z');
  });

  it('stamps on sign-in and token refresh', async () => {
    await set('ben', { lastActiveAt: null });
    const login = await h.raw(null, 'POST', '/api/auth/login', {
      method: 'api_key',
      apiKey: h.fake.mintKey('u-ben'),
    });
    expect(login.statusCode).toBe(200);
    await settleActivity();
    expect((await row('ben'))!.lastActiveAt).not.toBeNull();
    const { refreshToken } = login.json() as { refreshToken: string };
    await set('ben', { lastActiveAt: ago(2) });
    const r = await h.raw(null, 'POST', '/api/auth/refresh', { refreshToken });
    expect(r.statusCode).toBe(200);
    await settleActivity();
    expect((await row('ben'))!.lastActiveAt!.getTime()).toBe(new Date(NOW).getTime());
  });

  it('background syncing is not activity', async () => {
    await set('cat', { lastActiveAt: ago(40) });
    await syncUser(h.ctx, id('cat'), { settle: false }).catch(() => undefined);
    await runSyncCycle(h.ctx);
    await settleActivity();
    expect((await row('cat'))!.lastActiveAt!.toISOString()).toBe(ago(40).toISOString());
  });

  it('the demo account is not tracked', async () => {
    const res = await h.raw(null, 'POST', '/api/auth/demo');
    expect(res.statusCode).toBe(200);
    const { accessToken } = res.json() as { accessToken: string };
    await h.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    await settleActivity();
    const [demo] = await h.ctx.db.select().from(users).where(eq(users.isDemo, true));
    expect(demo!.lastActiveAt).toBeNull();
    await touchActive(h.ctx, demo!.id);
    expect(
      (await h.ctx.db.select().from(users).where(eq(users.id, demo!.id)))[0]!.lastActiveAt,
    ).toBeNull();
  });
});

describe('permissions', () => {
  const calls: [string, string, unknown?][] = [
    ['GET', '/api/admin/users'],
    ['GET', '/api/admin/users/00000000-0000-4000-8000-000000000000'],
    ['POST', '/api/admin/users/00000000-0000-4000-8000-000000000000/schedule-deletion', {}],
    ['POST', '/api/admin/users/00000000-0000-4000-8000-000000000000/cancel-deletion'],
    ['DELETE', '/api/admin/users/00000000-0000-4000-8000-000000000000', { confirm: 'x' }],
    ['POST', '/api/admin/users/cleanup-expired', { dryRun: true }],
    ['GET', '/api/admin/audit'],
    ['GET', '/api/admin/challenges'],
    ['POST', '/api/admin/badges/publish-all', {}],
    ['GET', '/api/admin/badges/backfill'],
  ];
  it.each(calls)('%s %s needs an admin', async (method, url, body) => {
    expect((await h.raw('ann', method, url, body)).statusCode).toBe(403);
    expect((await h.raw(null, method, url, body)).statusCode).toBe(401);
  });

  it('cannot delete or schedule yourself, other admins, or the demo account', async () => {
    const demo = (await h.ctx.db.select().from(users).where(eq(users.isDemo, true)))[0]!;
    for (const [target, name] of [
      [id('boss'), 'boss'],
      [id('other'), 'other'],
      [demo.id, demo.displayName],
    ] as const) {
      expect(
        (await h.raw('boss', 'DELETE', `/api/admin/users/${target}`, { confirm: name })).statusCode,
      ).toBe(403);
      expect(
        (await h.raw('boss', 'POST', `/api/admin/users/${target}/schedule-deletion`, {}))
          .statusCode,
      ).toBe(403);
    }
    expect(await row('other')).toBeDefined();
  });

  it('delete needs the right name', async () => {
    const a = await h.raw('boss', 'DELETE', `/api/admin/users/${id('dan')}`, {});
    expect(a.statusCode).toBe(400);
    const b = await h.raw('boss', 'DELETE', `/api/admin/users/${id('dan')}`, { confirm: 'nope' });
    expect(b.statusCode).toBe(400);
    expect(await row('dan')).toBeDefined();
  });
});

describe('listing', () => {
  it('filters, searches, sorts and pages', async () => {
    await set('ann', { lastActiveAt: ago(2) });
    await set('ben', { lastActiveAt: ago(60) });
    await set('cat', { lastActiveAt: ago(40), keyStatus: 'invalid' });
    await set('dan', { lastActiveAt: ago(3), lastSyncError: 'boom' });
    const get = (q: string) => h.call<AdminUsersResponse>('boss', 'GET', `/api/admin/users?${q}`);
    const names = (r: AdminUsersResponse) => r.users.map((u) => u.displayName);

    expect(names(await get('filter=expired'))).toEqual(['cat']);
    expect(names(await get('filter=inactive'))).toEqual(expect.arrayContaining(['ben', 'cat']));
    expect(names(await get('filter=active'))).toEqual(
      expect.arrayContaining(['ann', 'dan', 'boss']),
    );
    expect(names(await get('filter=problems')).sort()).toEqual(['cat', 'dan']);
    expect(names(await get('q=AN&sort=name&filter=all'))).toEqual(
      expect.arrayContaining(['ann', 'dan']),
    );

    const all = await get('sort=name');
    expect(all.total).toBeGreaterThanOrEqual(7);
    expect(all.counts.expired).toBe(1);
    const page = await get('sort=name&limit=2&offset=2');
    expect(page.users).toHaveLength(2);
    expect(page.users.map((u) => u.id)).toEqual(all.users.slice(2, 4).map((u) => u.id));
    expect(all.users.find((u) => u.displayName === 'boss')!.isAdmin).toBe(true);
    const demo = all.users.find((u) => u.isDemo)!;
    expect(demo.tags).toContain('demo');
    expect(demo.tags).not.toContain('expired');
  });

  it('counts challenges and friends', async () => {
    const [c] = await h.ctx.db
      .insert(challenges)
      .values({
        name: 'Done',
        metric: 'steps',
        aggregate: 'sum',
        scoring: 'total',
        startDate: '2026-09-01',
        endDate: '2026-09-10',
        timezone: 'UTC',
        createdBy: id('ann'),
        finalizedAt: ago(10),
      })
      .returning();
    await h.ctx.db.insert(challengeParticipants).values([
      { challengeId: c!.id, userId: id('ann'), state: 'joined', finalRank: 1 },
      { challengeId: c!.id, userId: id('ben'), state: 'joined', finalRank: 2 },
    ]);
    const r = await h.call<AdminUsersResponse>('boss', 'GET', '/api/admin/users?limit=200');
    expect(r.users.find((u) => u.displayName === 'ann')!.challenges).toEqual({
      active: 0,
      finished: 1,
      won: 1,
    });
    expect(r.users.find((u) => u.displayName === 'ben')!.challenges.won).toBe(0);
  });
});

describe('detail', () => {
  it('shows the picture without any secrets', async () => {
    await set('ann', {
      seenSources: { steps: ['garmin', 'fitbit'], weight: ['withings'] },
      notificationPrefs: { nudge: false },
      lastSyncError: 'Sparky said no',
    });
    await h.ctx.db.insert(pushTargets).values([
      {
        userId: id('ann'),
        kind: 'webpush',
        endpoint: 'https://push.example/very-secret-endpoint',
        keys: { p256dh: 'SECRET-P256', auth: 'SECRET-AUTH' },
      },
      { userId: id('ann'), kind: 'device', endpoint: 'sha-of-device-token' },
    ]);
    const [c] = await h.ctx.db
      .insert(challenges)
      .values({
        name: 'Step Wars',
        metric: 'steps',
        aggregate: 'sum',
        scoring: 'total',
        startDate: '2026-09-25',
        endDate: '2026-10-20',
        timezone: 'UTC',
        createdBy: id('ann'),
      })
      .returning();
    await h.ctx.db.insert(challengeParticipants).values({
      challengeId: c!.id,
      userId: id('ann'),
      state: 'joined',
    });
    const enc = (await row('ann'))!.sparkyKeyEnc!;

    const res = await h.raw('boss', 'GET', `/api/admin/users/${id('ann')}`);
    expect(res.statusCode).toBe(200);
    const d = res.json() as AdminUserDetail;
    expect(d.dataSources.sources).toEqual(['Fitbit', 'Garmin', 'Withings']);
    expect(d.dataSources.metrics).toBe(2);
    expect(d.pushTargets).toEqual({ webpush: 1, device: 1 });
    expect(d.notificationPrefsSet).toBe(1);
    expect(d.lastSyncError).toBe('Sparky said no');
    expect(d.challengeList).toMatchObject([
      { name: 'Step Wars', status: 'active', createdByThem: true },
    ]);
    expect(d.timezone).toBeTruthy();

    const text = res.body;
    for (const secret of [
      enc,
      'very-secret-endpoint',
      'SECRET-P256',
      'SECRET-AUTH',
      'sha-of-device-token',
    ]) {
      expect(text).not.toContain(secret);
    }
    for (const field of [
      'sparkyKeyEnc',
      'sparkyKeyId',
      'tokenHash',
      'p256dh',
      'endpoint',
      'keys',
      'sparkyUserId',
    ]) {
      expect(text).not.toContain(`"${field}"`);
    }
    // The list is clean too.
    const list = await h.raw('boss', 'GET', '/api/admin/users');
    expect(list.body).not.toContain(enc);
    expect(list.body).not.toContain('sparkyKeyEnc');
  });

  it('404s for an unknown account', async () => {
    expect(
      (await h.raw('boss', 'GET', '/api/admin/users/00000000-0000-4000-8000-000000000000'))
        .statusCode,
    ).toBe(404);
  });
});

describe('scheduling a deletion', () => {
  it('sets the date 30 days out, tells the person (always), shows in /api/me, audit trail', async () => {
    // They turned every notification off; the notice still goes through.
    await set('dan', { notificationPrefs: { nudge: false, badge: false } });
    const d = await h.call<AdminUserDetail>(
      'boss',
      'POST',
      `/api/admin/users/${id('dan')}/schedule-deletion`,
      { reason: 'Never used' },
    );
    expect(d.deletionScheduledAt).toBe(new Date(new Date(NOW).getTime() + 30 * DAY).toISOString());
    expect(d.deletionReason).toBe('Never used');
    expect(d.tags).toContain('scheduled');

    const notes = await h.call<NotificationsPage>('dan', 'GET', '/api/notifications');
    const n = notes.items.find((x: AppNotification) => x.kind === 'account');
    expect(n?.body).toBe(
      "Your Gauntlet account will be deleted on November 1, 2026 because it hasn't been used. Open the app to keep it.",
    );
    const me = await h.call<MeUser>('dan', 'GET', '/api/me');
    expect(me.deletionScheduledAt).toBe(d.deletionScheduledAt);
    const prefs = await h.call<{ kinds: { kind: string }[] }>(
      'dan',
      'GET',
      '/api/me/notification-prefs',
    );
    expect(prefs.kinds.map((k) => k.kind)).not.toContain('account');

    const audit = await h.call<{
      entries: { action: string; targetName: string; adminName: string }[];
    }>('boss', 'GET', '/api/admin/audit');
    expect(audit.entries[0]).toMatchObject({
      action: 'schedule_deletion',
      targetName: 'dan',
      adminName: 'boss',
    });
  });

  it('cancel clears it; "Keep my account" clears it too', async () => {
    await h.call('boss', 'POST', `/api/admin/users/${id('dan')}/schedule-deletion`, {});
    await h.call('boss', 'POST', `/api/admin/users/${id('dan')}/cancel-deletion`);
    expect((await row('dan'))!.deletionScheduledAt).toBeNull();
    expect(
      (await h.raw('boss', 'POST', `/api/admin/users/${id('dan')}/cancel-deletion`)).statusCode,
    ).toBe(400);

    await h.call('boss', 'POST', `/api/admin/users/${id('dan')}/schedule-deletion`, {});
    await h.call('dan', 'POST', '/api/me/keep-account');
    expect((await row('dan'))!.deletionScheduledAt).toBeNull();
    expect((await row('dan'))!.deletionReason).toBeNull();
  });

  it("the admin's own action does not count as the person's activity", async () => {
    await set('dan', { lastActiveAt: ago(50) });
    await h.call('boss', 'POST', `/api/admin/users/${id('dan')}/schedule-deletion`, {});
    await h.call('boss', 'GET', `/api/admin/users/${id('dan')}`);
    await settleActivity();
    expect((await row('dan'))!.lastActiveAt!.toISOString()).toBe(ago(50).toISOString());
  });
});

describe('the deletion sweep', () => {
  it('deletes only accounts that are overdue and inactive since scheduling', async () => {
    const dueIn = (days: number) => new Date(new Date(NOW).getTime() + days * DAY);
    // ann: due, quiet since long before it was scheduled -> deleted
    await set('ann', {
      deletionScheduledAt: dueIn(-1),
      lastActiveAt: ago(80),
      deletionReason: 'Expired',
    });
    // ben: due, but used the app after it was scheduled (scheduled 31 days ago) -> kept
    await set('ben', { deletionScheduledAt: dueIn(-1), lastActiveAt: ago(5) });
    // cat: not due yet -> untouched
    await set('cat', { deletionScheduledAt: dueIn(10), lastActiveAt: ago(80) });
    // dan: not scheduled at all
    await set('dan', { lastActiveAt: ago(300) });
    const r = await sweepScheduledDeletions(h.ctx);
    expect(r).toEqual({ deleted: 1, kept: 1 });
    expect(await row('ann')).toBeUndefined();
    expect((await row('ben'))!.deletionScheduledAt).toBeNull();
    expect((await row('cat'))!.deletionScheduledAt).not.toBeNull();
    expect(await row('dan')).toBeDefined();
    const audit = await h.call<{ entries: { action: string }[] }>(
      'boss',
      'GET',
      '/api/admin/audit',
    );
    expect(audit.entries.map((e) => e.action)).toEqual(
      expect.arrayContaining(['auto_delete', 'auto_keep']),
    );
  });

  it('runs as part of the scheduler cycle', async () => {
    await set('cat', { deletionScheduledAt: ago(1), lastActiveAt: ago(90) });
    await runSyncCycle(h.ctx);
    expect(await row('cat')).toBeUndefined();
  });
});

describe('deleting an account', () => {
  const challenge = async (createdBy: string, members: string[], extra: object = {}) => {
    const [c] = await h.ctx.db
      .insert(challenges)
      .values({
        name: `By ${createdBy}`,
        metric: 'steps',
        aggregate: 'sum',
        scoring: 'total',
        startDate: '2026-09-25',
        endDate: '2026-10-20',
        timezone: 'UTC',
        createdBy: id(createdBy),
        ...extra,
      })
      .returning();
    await h.ctx.db
      .insert(challengeParticipants)
      .values(
        members.map((m) => ({ challengeId: c!.id, userId: id(m), state: 'joined' as const })),
      );
    return c!.id;
  };

  it('keeps a challenge others are in, handing it to a participant; drops ones nobody else joined', async () => {
    const shared = await challenge('ann', ['ann', 'ben', 'cat']);
    const solo = await challenge('ann', ['ann']);
    const res = await h.raw('boss', 'DELETE', `/api/admin/users/${id('ann')}`, { confirm: 'ann' });
    expect(res.statusCode).toBe(200);
    expect(await row('ann')).toBeUndefined();
    const [kept] = await h.ctx.db.select().from(challenges).where(eq(challenges.id, shared));
    expect([id('ben'), id('cat')]).toContain(kept!.createdBy);
    const parts = await h.ctx.db
      .select()
      .from(challengeParticipants)
      .where(eq(challengeParticipants.challengeId, shared));
    expect(parts.map((p) => p.userId).sort()).toEqual([id('ben'), id('cat')].sort());
    expect(await h.ctx.db.select().from(challenges).where(eq(challenges.id, solo))).toHaveLength(0);
    const audit = await h.call<{ entries: { action: string; detail: string | null }[] }>(
      'boss',
      'GET',
      '/api/admin/audit',
    );
    expect(audit.entries[0]).toMatchObject({ action: 'delete_account' });
    expect(audit.entries[0]!.detail).toMatch(/1 challenge/);
  });

  it('signs them out and their own delete shares the same logic', async () => {
    const shared = await challenge('dan', ['dan', 'cat']);
    const { refreshToken } = (
      await h.raw(null, 'POST', '/api/auth/login', {
        method: 'api_key',
        apiKey: h.fake.mintKey('u-dan'),
      })
    ).json() as { refreshToken: string };
    expect((await h.raw('dan', 'DELETE', '/api/me')).statusCode).toBe(200);
    expect(await row('dan')).toBeUndefined();
    expect(
      (await h.ctx.db.select().from(challenges).where(eq(challenges.id, shared)))[0]!.createdBy,
    ).toBe(id('cat'));
    expect((await h.raw(null, 'POST', '/api/auth/refresh', { refreshToken })).statusCode).toBe(401);
  });
});

describe('cleaning up expired accounts', () => {
  beforeEach(async () => {
    await set('ben', { lastActiveAt: ago(200) }); // idle 180+
    await set('cat', { lastActiveAt: ago(35), keyStatus: 'revoked' }); // lost + 30+
    await set('dan', { lastActiveAt: ago(40), lastSyncedAt: null }); // never synced + 30+
    await set('ann', { lastActiveAt: ago(100) }); // quiet but healthy: fine
  });

  it('a dry run lists them and changes nothing', async () => {
    const r = await h.call<CleanupResult>('boss', 'POST', '/api/admin/users/cleanup-expired', {
      dryRun: true,
    });
    expect(r.dryRun).toBe(true);
    expect(r.accounts.map((a) => a.displayName).sort()).toEqual(['ben', 'cat', 'dan']);
    expect(r.accounts.every((a) => a.reason)).toBe(true);
    expect((await row('ben'))!.deletionScheduledAt).toBeNull();
  });

  it('the real run schedules (never deletes), skips already-scheduled, tells people', async () => {
    await set('cat', { deletionScheduledAt: ago(-3), deletionReason: 'Manual' });
    const r = await h.call<CleanupResult>('boss', 'POST', '/api/admin/users/cleanup-expired', {});
    expect(r.dryRun).toBe(false);
    expect(r.accounts.map((a) => a.displayName).sort()).toEqual(['ben', 'dan']);
    for (const w of ['ben', 'dan']) {
      const u = (await row(w))!;
      expect(u.deletionScheduledAt!.getTime()).toBe(new Date(NOW).getTime() + 30 * DAY);
      expect(u.deletionReason).toBe('Expired');
    }
    expect((await row('cat'))!.deletionReason).toBe('Manual');
    expect(await row('ann')).toBeDefined();
    expect((await row('ann'))!.deletionScheduledAt).toBeNull();
    const notes = await h.call<NotificationsPage>('ben', 'GET', '/api/notifications');
    expect(notes.items.some((n) => n.kind === 'account')).toBe(true);
    expect((await cleanupExpired(h.ctx, id('boss'), true)).accounts).toHaveLength(0);
  });

  it('never touches admins or the demo account', async () => {
    await set('other', { lastActiveAt: ago(500) });
    const r = await h.call<CleanupResult>('boss', 'POST', '/api/admin/users/cleanup-expired', {
      dryRun: true,
    });
    expect(r.accounts.map((a) => a.displayName)).not.toContain('other');
    expect(r.accounts.map((a) => a.displayName)).not.toContain('Alex Morgan');
  });
});

describe('challenges overview', () => {
  it('lists with filters, and lets admins look (read-only) at a private challenge', async () => {
    const mk = async (name: string, start: string, end: string, extra: object = {}) => {
      const [c] = await h.ctx.db
        .insert(challenges)
        .values({
          name,
          metric: 'steps',
          aggregate: 'sum',
          scoring: 'total',
          startDate: start,
          endDate: end,
          timezone: 'UTC',
          createdBy: id('ann'),
          ...extra,
        })
        .returning();
      await h.ctx.db.insert(challengeParticipants).values([
        { challengeId: c!.id, userId: id('ann'), state: 'joined' },
        { challengeId: c!.id, userId: id('ben'), state: 'joined' },
        { challengeId: c!.id, userId: id('cat'), state: 'invited' },
      ]);
      return c!.id;
    };
    const running = await mk('Running one', '2026-09-28', '2026-10-10', {
      leaderId: id('ben'),
      visibility: 'public',
      featured: true,
    });
    await mk('Soon', '2026-10-10', '2026-10-20');
    await mk('Over', '2026-09-01', '2026-09-10', { finalizedAt: ago(10) });

    const all = await h.call<AdminChallengesResponse>('boss', 'GET', '/api/admin/challenges');
    expect(all.counts).toEqual({ running: 1, upcoming: 1, finished: 1, all: 3 });
    expect(all.challenges.map((c) => c.name)).toEqual(['Running one', 'Soon', 'Over']);
    expect(all.challenges[0]).toMatchObject({
      metricLabel: expect.any(String),
      joined: 2,
      invited: 1,
      visibility: 'public',
      featured: true,
      leader: { displayName: 'ben' },
      creator: { displayName: 'ann' },
    });
    const only = await h.call<AdminChallengesResponse>(
      'boss',
      'GET',
      '/api/admin/challenges?status=finished&q=ov',
    );
    expect(only.challenges.map((c) => c.name)).toEqual(['Over']);

    // Private: members and admins can open it; strangers cannot; admins cannot act as a member.
    const priv = all.challenges.find((c) => c.name === 'Soon')!.id;
    expect((await h.raw('boss', 'GET', `/api/challenges/${priv}`)).statusCode).toBe(200);
    expect((await h.raw('boss', 'GET', `/api/challenges/${priv}/progress`)).statusCode).toBe(200);
    expect((await h.raw('dan', 'GET', `/api/challenges/${priv}`)).statusCode).toBe(403);
    expect(
      (await h.raw('boss', 'POST', `/api/challenges/${priv}/respond`, { accept: true })).statusCode,
    ).toBe(403);
    expect((await h.raw('boss', 'GET', `/api/challenges/${running}`)).statusCode).toBe(200);
  });
});

describe('publish all', () => {
  const draft = (key: string, status: 'draft' | 'live' | 'retired' = 'draft') =>
    h.ctx.db.insert(badgeDefinitions).values({
      key,
      name: `Badge ${key}`,
      description: 'd',
      family: 'steps',
      icon: 'steps',
      rule: { type: 'day_metric', metric: 'steps', tiers: [1000], op: 'gte', days: 1 } as never,
      status,
    });

  it('publishes every draft, queues backfills one at a time, and reports progress', async () => {
    await h.ctx.db.delete(badgeDefinitions);
    await draft('aaa-one');
    await draft('bbb-two');
    await draft('ccc-three');
    await draft('ddd-live', 'live');
    await draft('eee-retired', 'retired');
    const r = await h.call<{ published: number }>(
      'boss',
      'POST',
      '/api/admin/badges/publish-all',
      {},
    );
    expect(r.published).toBe(3);
    await settleBadgeTasks();
    const defs = await h.ctx.db.select().from(badgeDefinitions);
    expect(Object.fromEntries(defs.map((d) => [d.key, d.status]))).toEqual({
      'aaa-one': 'live',
      'bbb-two': 'live',
      'ccc-three': 'live',
      'ddd-live': 'live',
      'eee-retired': 'retired',
    });
    const s = await h.call<BadgeBackfillStatus>('boss', 'GET', '/api/admin/badges/backfill');
    expect(s).toMatchObject({ running: false, done: 3, total: 3 });
  });

  it('publish selected only touches the chosen drafts', async () => {
    await h.ctx.db.delete(badgeDefinitions);
    await draft('sel-one');
    await draft('sel-two');
    await draft('sel-live', 'live');
    const r = await h.call<{ published: number }>('boss', 'POST', '/api/admin/badges/publish-all', {
      keys: ['sel-one', 'sel-live'],
    });
    expect(r.published).toBe(1);
    await settleBadgeTasks();
    const two = await h.ctx.db
      .select()
      .from(badgeDefinitions)
      .where(eq(badgeDefinitions.key, 'sel-two'));
    expect(two[0]!.status).toBe('draft');
  });

  it('a queue left by a restart is picked up again', async () => {
    const { resumeBadgeBackfill } = await import('../src/services/badges/publishAll.js');
    await h.ctx.db.delete(badgeDefinitions);
    await draft('res-one', 'live');
    await h.ctx.db
      .insert(serverState)
      .values({ key: 'badge_backfill', value: { queue: ['res-one'], done: 4, total: 5 } })
      .onConflictDoUpdate({
        target: serverState.key,
        set: { value: { queue: ['res-one'], done: 4, total: 5 } },
      });
    expect(
      (await h.call<BadgeBackfillStatus>('boss', 'GET', '/api/admin/badges/backfill')).running,
    ).toBe(true);
    await resumeBadgeBackfill(h.ctx);
    await settleBadgeTasks();
    expect(
      await h.call<BadgeBackfillStatus>('boss', 'GET', '/api/admin/badges/backfill'),
    ).toMatchObject({
      running: false,
      done: 5,
      total: 5,
    });
  });
});
