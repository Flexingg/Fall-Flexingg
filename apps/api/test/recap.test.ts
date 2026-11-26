import {
  isoWeekOf,
  isoWeekStart,
  previousIsoWeek,
  type AppNotification,
  type NotificationsPage,
  type WeeklyRecap,
} from '@gauntlet/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from '../src/db/schema.js';
import { runSyncCycle } from '../src/scheduler.js';
import { syncUser } from '../src/services/sync.js';
import { setup, type Harness } from './notifyHarness.js';

describe('ISO weeks', () => {
  it('numbers weeks Monday to Sunday', () => {
    expect(isoWeekOf('2026-11-23')).toBe('2026-W48');
    expect(isoWeekOf('2026-11-22')).toBe('2026-W47');
    expect(isoWeekOf('2026-01-01')).toBe('2026-W01');
    expect(isoWeekOf('2027-01-03')).toBe('2026-W53');
    expect(isoWeekStart('2026-W47')).toBe('2026-11-16');
    expect(isoWeekStart('2026-W01')).toBe('2025-12-29');
    expect(previousIsoWeek('2026-11-23')).toBe('2026-W47');
    expect(previousIsoWeek('2025-12-29')).toBe('2025-W52');
  });
});

let h: Harness;
beforeAll(async () => {
  h = await setup(['ann', 'ben', 'cat']);
  // Ann is on UTC; Ben is in Los Angeles, where it is still Sunday night when Ann's Monday starts.
  await h.ctx.db
    .update(users)
    .set({ timezone: 'America/Los_Angeles' })
    .where(eq(users.id, h.ids.ben!));
  await h.call('ann', 'POST', '/api/friends/requests', { email: 'ben@example.com' });
  await h.call('ben', 'POST', `/api/friends/requests/${h.ids.ann}/accept`);
});
afterAll(() => h.close());

const inbox = async (who: string): Promise<AppNotification[]> =>
  (await h.call<NotificationsPage>(who, 'GET', '/api/notifications')).items.filter(
    (n) => n.kind === 'weekly_recap',
  );
const quiet = () => new Promise((r) => setTimeout(r, 400));

const steps = (who: string, list: [string, number, Record<string, number>?][]) => {
  h.sparky[who]!.daily = list.map(([entry_date, total_steps, extra]) => ({
    entry_date,
    source_provider: 'garmin',
    total_steps,
    ...extra,
  }));
};

const annWeeks = () => {
  steps('ann', [
    ['2026-11-09', 5000],
    ['2026-11-10', 5000],
    ['2026-11-11', 5000],
    ['2026-11-12', 5000],
    ['2026-11-13', 5000],
    ['2026-11-14', 5000],
    ['2026-11-15', 5000],
    ['2026-11-16', 8000],
    ['2026-11-17', 12000, { exercise_minutes: 30 }],
    ['2026-11-18', 20000],
    ['2026-11-23', 1000],
  ]);
  h.sparky.ann!.daily[0] = { ...h.sparky.ann!.daily[0]!, total_distance_meters: 0 };
  h.sparky.ann!.daily.find((d) => d.entry_date === '2026-11-16')!.total_distance_meters = 5000;
};

describe('weekly recap', () => {
  let raceId = '';

  it('is built on Monday after 7:00 local, once per week, only with data', async () => {
    // A challenge that runs inside the recapped week and ends before Monday.
    h.setClock('2026-11-17T12:00:00Z');
    const race = await h.call<{ id: string }>('ann', 'POST', '/api/challenges', {
      name: 'Week race',
      metric: 'steps',
      scoring: 'total',
      startDate: '2026-11-17',
      endDate: '2026-11-22',
      timezone: 'UTC',
      inviteUserIds: [h.ids.ben],
    });
    raceId = race.id;
    await h.call('ben', 'POST', `/api/challenges/${raceId}/respond`, { accept: true });
    await quiet();

    annWeeks();
    steps('ben', [
      ['2026-11-19', 30000],
      ['2026-11-23', 500],
    ]);

    // Monday 06:00 UTC: too early for Ann.
    h.setClock('2026-11-23T06:00:00Z');
    await syncUser(h.ctx, h.ids.ann!);
    await syncUser(h.ctx, h.ids.ben!);
    await h.call('ann', 'POST', '/api/challenges', {
      name: 'New week',
      metric: 'steps',
      scoring: 'total',
      startDate: '2026-11-23',
      endDate: '2026-11-29',
      timezone: 'UTC',
      inviteUserIds: [h.ids.ben],
    });
    const created = (
      await h.call<{ id: string; name: string }[]>('ann', 'GET', '/api/challenges')
    ).find((c) => c.name === 'New week')!;
    await h.call('ben', 'POST', `/api/challenges/${created.id}/respond`, { accept: true });
    await quiet();
    await runSyncCycle(h.ctx);
    expect(await inbox('ann')).toHaveLength(0);

    // 07:30 UTC: Ann's Monday morning. Ben is still on Sunday night; Cat has no data.
    h.setClock('2026-11-23T07:30:00Z');
    await runSyncCycle(h.ctx);
    const ann = await inbox('ann');
    expect(ann).toHaveLength(1);
    expect(ann[0]).toMatchObject({ title: 'Your week in review', url: '/recap/2026-W47' });
    expect(ann[0]!.body).toContain('40k steps');
    expect(ann[0]!.body).toContain('+14%');
    expect(await inbox('ben')).toHaveLength(0);
    expect(await inbox('cat')).toHaveLength(0);
    const [row] = await h.ctx.db
      .select({ w: users.lastRecapWeek })
      .from(users)
      .where(eq(users.id, h.ids.ann!));
    expect(row!.w).toBe('2026-W47');

    // Running the cycle again, or later that day, doesn't repeat it.
    await runSyncCycle(h.ctx);
    h.setClock('2026-11-23T12:00:00Z');
    await runSyncCycle(h.ctx);
    expect(await inbox('ann')).toHaveLength(1);

    // 15:30 UTC is 07:30 in Los Angeles.
    h.setClock('2026-11-23T15:30:00Z');
    await runSyncCycle(h.ctx);
    expect(await inbox('ben')).toHaveLength(1);
    expect(await inbox('ann')).toHaveLength(1);
    expect(await inbox('cat')).toHaveLength(0);

    // Not on other days.
    h.setClock('2026-11-24T09:00:00Z');
    await runSyncCycle(h.ctx);
    expect(await inbox('ann')).toHaveLength(1);
  });

  it('GET /api/me/recap/:week has the totals, the comparison, best day, records and challenges', async () => {
    // A record friends were told about that week.
    await h.ctx.db.execute(sql`insert into feed_events (actor_id, kind, payload, created_at)
      values (${h.ids.ann!}, 'personal_record',
        '{"label":"best step day","badge":"20,000"}'::jsonb, '2026-11-18T20:00:00Z')`);
    h.setClock('2026-11-24T09:00:00Z');
    annWeeks();
    await syncUser(h.ctx, h.ids.ann!);
    const recap = await h.call<WeeklyRecap>('ann', 'GET', '/api/me/recap/2026-W47');
    expect(recap).toMatchObject({
      week: '2026-W47',
      start: '2026-11-16',
      end: '2026-11-22',
      hasData: true,
      bestDay: { date: '2026-11-18', steps: 20000 },
    });
    const total = (k: string) => recap.totals.find((t) => t.key === k)!;
    expect(total('steps')).toMatchObject({ value: 40000, previous: 35000, changePct: 14 });
    expect(total('distance')).toMatchObject({ value: 5, previous: 0, changePct: null });
    expect(total('active_minutes').value).toBe(30);
    expect(total('workouts').value).toBe(0);
    expect(recap.records).toEqual(['New best step day: 20,000']);
    expect(recap.finished).toEqual([{ challengeId: raceId, name: 'Week race', rank: 1, of: 2 }]);
    expect(recap.standings.map((s) => [s.name, s.rank])).toEqual([['New week', 1]]);
  });

  it('says so when a week has nothing, and refuses a bad week', async () => {
    const empty = await h.call<WeeklyRecap>('cat', 'GET', '/api/me/recap/2026-W47');
    expect(empty.hasData).toBe(false);
    expect(empty.bestDay).toBeNull();
    expect((await h.raw('ann', 'GET', '/api/me/recap/last-week')).statusCode).toBe(400);
    expect((await h.raw(null, 'GET', '/api/me/recap/2026-W47')).statusCode).toBe(401);
  });

  it('respects the opt-out but still marks the week done', async () => {
    await h.call('ann', 'PUT', '/api/me/notification-prefs', { prefs: { weekly_recap: false } });
    await h.ctx.db.update(users).set({ lastRecapWeek: null }).where(eq(users.id, h.ids.ann!));
    h.setClock('2026-11-30T08:00:00Z'); // the Monday after: last week is 2026-W48
    annWeeks();
    await syncUser(h.ctx, h.ids.ann!);
    await runSyncCycle(h.ctx);
    expect(await inbox('ann')).toHaveLength(1);
    const [row] = await h.ctx.db
      .select({ w: users.lastRecapWeek })
      .from(users)
      .where(eq(users.id, h.ids.ann!));
    expect(row!.w).toBe('2026-W48');
  });
});
