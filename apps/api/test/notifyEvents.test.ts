import type { AppNotification, ChallengeDetail, NotificationsPage } from '@gauntlet/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSyncCycle } from '../src/scheduler.js';
import { syncUser } from '../src/services/sync.js';
import { setup, type Harness } from './notifyHarness.js';

let h: Harness;
const names = ['ann', 'ben', 'cat', 'dan'];
beforeAll(async () => {
  h = await setup(names);
});
afterAll(() => h.close());

const inbox = async (who: string, kind?: string): Promise<AppNotification[]> => {
  const page = await h.call<NotificationsPage>(who, 'GET', '/api/notifications');
  return page.items.filter((n) => !kind || n.kind === kind);
};
const quiet = () => new Promise((r) => setTimeout(r, 500));

describe('friend requests', () => {
  it('tells the person asked, once', async () => {
    await h.call('ann', 'POST', '/api/friends/requests', { email: 'ben@example.com' });
    const [n, ...rest] = await inbox('ben', 'friend_request');
    expect(rest).toHaveLength(0);
    expect(n).toMatchObject({ title: 'New friend request', url: '/friends', read: false });
    expect(n!.body).toContain('ann');
    // Asking again, or the other person asking back (which just accepts), is not news.
    await h.call('ann', 'POST', '/api/friends/requests', { email: 'ben@example.com' });
    await h.call('ben', 'POST', '/api/friends/requests', { email: 'ann@example.com' });
    expect(await inbox('ben', 'friend_request')).toHaveLength(1);
    expect(await inbox('ann', 'friend_request')).toHaveLength(0);
  });

  it('respects the opt-out', async () => {
    await h.call('cat', 'PUT', '/api/me/notification-prefs', { prefs: { friend_request: false } });
    await h.call('ann', 'POST', '/api/friends/requests', { email: 'cat@example.com' });
    expect(await inbox('cat', 'friend_request')).toHaveLength(0);
  });
});

describe('challenge invites', () => {
  it('tells everyone invited, at creation and later, but not the creator or solo challenges', async () => {
    await h.call('ann', 'POST', '/api/friends/requests', { email: 'dan@example.com' });
    await h.call('dan', 'POST', `/api/friends/requests/${h.ids.ann}/accept`);
    await h.call('cat', 'POST', `/api/friends/requests/${h.ids.ann}/accept`);
    const ch = await h.call<ChallengeDetail>('ann', 'POST', '/api/challenges', {
      name: 'Race',
      metric: 'distance',
      scoring: 'total',
      startDate: '2026-10-02',
      endDate: '2026-10-04',
      timezone: 'UTC',
      inviteUserIds: [h.ids.ben],
    });
    const ben = await inbox('ben', 'challenge_invite');
    expect(ben).toHaveLength(1);
    expect(ben[0]).toMatchObject({ url: `/c/${ch.id}`, title: 'Challenge invite' });
    expect(ben[0]!.body).toContain('Race');
    expect(await inbox('ann', 'challenge_invite')).toHaveLength(0);

    await h.call('ann', 'POST', `/api/challenges/${ch.id}/invite`, { userIds: [h.ids.dan] });
    expect(await inbox('dan', 'challenge_invite')).toHaveLength(1);

    await h.call('ann', 'POST', '/api/challenges', {
      name: 'Just me',
      metric: 'distance',
      scoring: 'race_to_goal',
      goal: 10,
      solo: { kind: 'target' },
      startDate: '2026-10-02',
      endDate: '2026-10-04',
      timezone: 'UTC',
    });
    expect(await inbox('ann')).toHaveLength(0);
  });
});

describe('lead changes and results', () => {
  let id = '';
  const km = (who: string, value: number) => {
    h.sparky[who]!.daily = [
      { entry_date: '2026-10-02', source_provider: 'garmin', total_distance_meters: value * 1000 },
    ];
  };
  const sync = async (who: string) => {
    await syncUser(h.ctx, h.ids[who]!);
  };

  it('tells the person overtaken, at most once per challenge per 6 hours', async () => {
    const res = await h.raw('ann', 'GET', '/api/challenges');
    id = (res.json() as { id: string; name: string }[]).find((c) => c.name === 'Race')!.id;
    await h.call('ben', 'POST', `/api/challenges/${id}/respond`, { accept: true });
    await h.call('dan', 'POST', `/api/challenges/${id}/respond`, { accept: true });
    await quiet();

    // Ann is first to score: that is not an overtake.
    km('ann', 5);
    await sync('ann');
    expect(await inbox('ann', 'lead_change')).toHaveLength(0);

    // Ben passes her: Ann hears, nobody else does.
    km('ben', 10);
    await sync('ben');
    const first = await inbox('ann', 'lead_change');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ title: 'You lost the lead', url: `/c/${id}` });
    expect(first[0]!.body).toContain('ben');
    expect(first[0]!.body).toContain('Race');
    expect(await inbox('ben', 'lead_change')).toHaveLength(0);
    expect(await inbox('dan', 'lead_change')).toHaveLength(0);

    // Ann retakes it, Ben hears; then Ben retakes it within 6 hours, and Ann is not pinged again.
    km('ann', 20);
    await sync('ann');
    expect(await inbox('ben', 'lead_change')).toHaveLength(1);
    km('ben', 30);
    await sync('ben');
    expect(await inbox('ann', 'lead_change')).toHaveLength(1);
    expect(await inbox('ben', 'lead_change')).toHaveLength(1);
  });

  it('tells them again once six hours have passed', async () => {
    // Pretend the earlier alerts went out 7 hours ago.
    await h.ctx.db.execute(
      sql`update notifications set created_at = now() - interval '7 hours' where kind = 'lead_change'`,
    );
    km('ann', 40);
    await sync('ann');
    km('ben', 50);
    await sync('ben');
    expect(await inbox('ann', 'lead_change')).toHaveLength(2);
  });

  it('opt-outs are respected for lead changes', async () => {
    await h.call('ann', 'PUT', '/api/me/notification-prefs', { prefs: { lead_change: false } });
    km('ann', 80);
    await sync('ann');
    km('ben', 90);
    await sync('ben');
    expect(await inbox('ann', 'lead_change')).toHaveLength(2);
    await h.call('ann', 'PUT', '/api/me/notification-prefs', { prefs: { lead_change: true } });
  });

  it('tells every participant where they finished, exactly once', async () => {
    h.setClock('2026-10-05T12:00:00Z'); // after the end date
    expect((await runSyncCycle(h.ctx)).finalized).toBeGreaterThanOrEqual(1);
    const ann = await inbox('ann', 'challenge_finished');
    const ben = await inbox('ben', 'challenge_finished');
    expect(ann).toHaveLength(1);
    expect(ann[0]).toMatchObject({ title: 'Race is over', url: `/c/${id}/result` });
    expect(ann[0]!.body).toMatch(/second|2nd/);
    expect(ben[0]!.body).toMatch(/first|won/i);
    // Dan never scored; the solo challenge told nobody.
    expect(await inbox('dan', 'challenge_finished')).toHaveLength(1);
    expect(ann.some((n) => n.title.includes('Just me'))).toBe(false);

    await runSyncCycle(h.ctx);
    expect(await inbox('ann', 'challenge_finished')).toHaveLength(1);
    expect(await inbox('ben', 'challenge_finished')).toHaveLength(1);
  });
});
