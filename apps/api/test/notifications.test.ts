import type { NotificationPrefsResponse, NotificationsPage } from '@gauntlet/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notifications, users } from '../src/db/schema.js';
import { notify } from '../src/services/notify.js';
import { pruneNotifications } from '../src/services/push.js';
import { setup, type Harness } from './notifyHarness.js';

let h: Harness;
beforeAll(async () => {
  h = await setup(['ann', 'ben']);
});
afterAll(() => h.close());

const send = (who: 'ann' | 'ben', title: string, kind: 'nudge' | 'reaction' = 'nudge') =>
  notify(h.ctx, h.ids[who]!, { kind, title, body: `body of ${title}`, url: '/friends' });

describe('the notification list', () => {
  it('lists newest first with the unread count, and pages with before', async () => {
    for (let i = 1; i <= 35; i++) {
      await send('ann', `n${i}`);
      await new Promise((r) => setTimeout(r, 3));
    }
    await send('ben', 'for ben');
    const first = await h.call<NotificationsPage>('ann', 'GET', '/api/notifications');
    expect(first.items).toHaveLength(30);
    expect(first.items[0]!.title).toBe('n35');
    expect(first.items[0]!.read).toBe(false);
    expect(first.nextBefore).toBeTruthy();
    const second = await h.call<NotificationsPage>(
      'ann',
      'GET',
      `/api/notifications?before=${encodeURIComponent(first.nextBefore!)}`,
    );
    expect(second.items.map((i) => i.title)).toEqual(['n5', 'n4', 'n3', 'n2', 'n1']);
    expect(second.nextBefore).toBeNull();
    // Never someone else's.
    expect([...first.items, ...second.items].some((i) => i.title === 'for ben')).toBe(false);
    expect(
      (await h.call<{ count: number }>('ann', 'GET', '/api/notifications/unread-count')).count,
    ).toBe(35);
  });

  it('marks one read, only for its owner', async () => {
    const page = await h.call<NotificationsPage>('ann', 'GET', '/api/notifications');
    const id = page.items[0]!.id;
    expect((await h.raw('ben', 'POST', `/api/notifications/${id}/read`)).statusCode).toBe(404);
    expect((await h.raw('ann', 'POST', '/api/notifications/not-an-id/read')).statusCode).toBe(404);
    await h.call('ann', 'POST', `/api/notifications/${id}/read`);
    const after = await h.call<NotificationsPage>('ann', 'GET', '/api/notifications');
    expect(after.items[0]!.read).toBe(true);
    expect(
      (await h.call<{ count: number }>('ann', 'GET', '/api/notifications/unread-count')).count,
    ).toBe(34);
    expect(
      (await h.call<{ count: number }>('ben', 'GET', '/api/notifications/unread-count')).count,
    ).toBe(1);
  });

  it('marks all read, without touching other people', async () => {
    await h.call('ann', 'POST', '/api/notifications/read-all');
    expect(
      (await h.call<{ count: number }>('ann', 'GET', '/api/notifications/unread-count')).count,
    ).toBe(0);
    expect(
      (await h.call<{ count: number }>('ben', 'GET', '/api/notifications/unread-count')).count,
    ).toBe(1);
  });

  it('needs sign-in', async () => {
    expect((await h.raw(null, 'GET', '/api/notifications')).statusCode).toBe(401);
  });
});

describe('preferences', () => {
  it('lists every kind with defaults on, saves changes and keeps the rest', async () => {
    const start = await h.call<NotificationPrefsResponse>(
      'ben',
      'GET',
      '/api/me/notification-prefs',
    );
    expect(start.kinds.length).toBeGreaterThanOrEqual(10);
    expect(start.kinds.every((k) => k.enabled)).toBe(true);
    expect(start.kinds.find((k) => k.kind === 'nudge')!.label).toMatch(/nudge/i);

    await h.call('ben', 'PUT', '/api/me/notification-prefs', { prefs: { nudge: false } });
    const next = await h.call<NotificationPrefsResponse>(
      'ben',
      'PUT',
      '/api/me/notification-prefs',
      {
        prefs: { reaction: false },
      },
    );
    const off = next.kinds.filter((k) => !k.enabled).map((k) => k.kind);
    expect(off.sort()).toEqual(['nudge', 'reaction']);
  });

  it('refuses unknown kinds', async () => {
    const res = await h.raw('ben', 'PUT', '/api/me/notification-prefs', { prefs: { bogus: true } });
    expect(res.statusCode).toBe(400);
  });

  it('respects an opt-out: nothing is stored, nothing is delivered', async () => {
    const before = (
      await h.call<{ count: number }>('ben', 'GET', '/api/notifications/unread-count')
    ).count;
    expect(await send('ben', 'muted nudge', 'nudge')).toBeNull();
    expect(await send('ben', 'muted reaction', 'reaction')).toBeNull();
    expect(
      (await h.call<{ count: number }>('ben', 'GET', '/api/notifications/unread-count')).count,
    ).toBe(before);
    // Turning it back on lets it through.
    await h.call('ben', 'PUT', '/api/me/notification-prefs', { prefs: { nudge: true } });
    expect(await send('ben', 'welcome back nudge', 'nudge')).not.toBeNull();
  });

  it('does not notify the demo account', async () => {
    const [demo] = await h.ctx.db.select({ id: users.id }).from(users).limit(1);
    await h.ctx.db.update(users).set({ isDemo: true }).where(eq(users.id, demo!.id));
    expect(await notify(h.ctx, demo!.id, { kind: 'nudge', title: 'x', body: 'y' })).toBeNull();
    await h.ctx.db.update(users).set({ isDemo: false }).where(eq(users.id, demo!.id));
  });
});

describe('pruning', () => {
  it('deletes notifications older than 60 days and keeps newer ones', async () => {
    await h.ctx.db.delete(notifications);
    const keep = await send('ann', 'recent');
    const old = await send('ann', 'ancient');
    await h.ctx.db
      .update(notifications)
      .set({ createdAt: sql`now() - interval '61 days'` })
      .where(eq(notifications.id, old!.id));
    const fresh = await send('ann', 'almost old');
    await h.ctx.db
      .update(notifications)
      .set({ createdAt: sql`now() - interval '59 days'` })
      .where(eq(notifications.id, fresh!.id));
    // The clock the app sees is Oct 2026; the rows above are relative to the real clock, so move
    // the app's clock to the real one for this check.
    h.setClock(new Date().toISOString());
    expect(await pruneNotifications(h.ctx)).toBe(1);
    const left = await h.ctx.db.select({ id: notifications.id }).from(notifications);
    expect(left.map((r) => r.id).sort()).toEqual([keep!.id, fresh!.id].sort());
  });
});
