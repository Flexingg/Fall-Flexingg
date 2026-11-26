import type { AppNotification, FeedEvent, NotificationsPage } from '@gauntlet/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personalRecords } from '../src/db/schema.js';
import { bestsFrom } from '../src/services/records.js';
import { syncUser } from '../src/services/sync.js';
import { setup, type Harness } from './notifyHarness.js';

describe('bestsFrom', () => {
  const row = (date: string, metric: string, value: number) => ({ date, metric, value });
  it('ignores today for day totals, but not for lifts, and finds the longest 10k streak', () => {
    const b = bestsFrom(
      [
        row('2026-09-20', 'steps', 10000),
        row('2026-09-21', 'steps', 12000),
        row('2026-09-22', 'steps', 9000),
        row('2026-09-23', 'steps', 11000),
        row('2026-09-24', 'steps', 11000),
        row('2026-09-25', 'steps', 11000),
        row('2026-10-02', 'steps', 40000),
        row('2026-10-02', 'distance', 99),
        row('2026-10-02', 'lift_max:squat', 120),
        row('2026-10-01', 'lift_e1rm:squat', 140),
      ],
      '2026-10-02',
    );
    expect(b.get('steps_day')).toMatchObject({ value: 12000, date: '2026-09-21' });
    expect(b.has('distance_day')).toBe(false);
    expect(b.get('step_streak')).toMatchObject({ value: 3, date: '2026-09-25' });
    expect(b.get('lift_max:squat')!.value).toBe(120);
    expect(b.get('lift_e1rm:squat')!.value).toBe(140);
  });
});

let h: Harness;
beforeAll(async () => {
  h = await setup(['ann', 'ben']);
  await h.call('ann', 'POST', '/api/friends/requests', { email: 'ben@example.com' });
  await h.call('ben', 'POST', `/api/friends/requests/${h.ids.ann}/accept`);
});
afterAll(() => h.close());

const days = (list: [string, number][]) => {
  h.sparky.ann!.daily = list.map(([entry_date, steps]) => ({
    entry_date,
    source_provider: 'garmin',
    total_steps: steps,
  }));
};
const squat = (date: string, kg: number) => ({
  entry_date: date,
  exercise_name: 'Squat',
  exercise_source: 'liftosaur',
  duration_minutes: 0,
  sets: [{ set_type: 'Working Set', reps: 5, weight: kg }],
});
const records = async () =>
  Object.fromEntries(
    (
      await h.ctx.db.select().from(personalRecords).where(eq(personalRecords.userId, h.ids.ann!))
    ).map((r) => [r.key, r.value]),
  );
const alerts = async (): Promise<AppNotification[]> =>
  (await h.call<NotificationsPage>('ann', 'GET', '/api/notifications')).items.filter(
    (n) => n.kind === 'personal_record',
  );
const sync = () => syncUser(h.ctx, h.ids.ann!);

describe('personal records after a sync', () => {
  it('stores the first sighting silently (history is not news)', async () => {
    days([
      ['2026-09-25', 10000],
      ['2026-09-26', 16950],
      ['2026-09-27', 12000],
      ['2026-10-02', 5000],
    ]);
    h.sparky.ann!.exerciseEntries = [squat('2026-09-30', 100)];
    await sync();
    const r = await records();
    expect(r.steps_day).toBe(16950);
    expect(r.step_streak).toBe(3);
    expect(r['lift_max:squat']).toBe(100);
    expect(await alerts()).toHaveLength(0);
    expect(
      (await h.call<FeedEvent[]>('ann', 'GET', '/api/feed')).filter(
        (e) => e.kind === 'personal_record',
      ),
    ).toHaveLength(0);
  });

  it('a record moved again straight away stays quiet (still the same session)', async () => {
    days([
      ['2026-09-25', 10000],
      ['2026-09-26', 17500],
      ['2026-09-27', 12000],
      ['2026-10-02', 5000],
    ]);
    await sync();
    expect((await records()).steps_day).toBe(17500);
    expect(await alerts()).toHaveLength(0);
  });

  it('tells you, and your friends, when a record is beaten', async () => {
    h.setClock('2026-10-02T23:00:00Z');
    days([
      ['2026-09-25', 10000],
      ['2026-09-26', 17500],
      ['2026-09-27', 12000],
      ['2026-09-28', 18204],
      ['2026-10-02', 5000],
    ]);
    await sync();
    expect((await records()).steps_day).toBe(18204);
    const a = await alerts();
    expect(a.map((n) => n.body)).toContain('New best step day: 18,204 (was 17,500)');
    expect(a.map((n) => n.body)).toContain('New longest 10k-step streak: 4 days (was 3)');
    expect(a[0]).toMatchObject({ title: 'New personal record', url: '/trends' });

    const feed = (await h.call<FeedEvent[]>('ben', 'GET', '/api/feed')).filter(
      (e) => e.kind === 'personal_record',
    );
    expect(feed.map((e) => e.text)).toContain('ann set a new best step day');
    expect(feed.find((e) => e.text.includes('step day'))!.badge).toBe('18,204');
    expect(feed[0]!.actor.id).toBe(h.ids.ann);
  });

  it("ignores today's still-growing total", async () => {
    const before = (await alerts()).length;
    days([
      ['2026-09-28', 18204],
      ['2026-10-02', 30000],
    ]);
    await sync();
    expect((await records()).steps_day).toBe(18204);
    expect(await alerts()).toHaveLength(before);
  });

  it('counts that day once it is over', async () => {
    h.setClock('2026-10-03T09:00:00Z');
    await sync();
    expect((await records()).steps_day).toBe(30000);
    expect((await alerts()).map((n) => n.body)).toContain('New best step day: 30,000 (was 18,204)');
  });

  it('lift records count right away, one alert each', async () => {
    h.setClock('2026-10-03T15:00:00Z');
    h.sparky.ann!.exerciseEntries = [squat('2026-09-30', 100), squat('2026-10-03', 110)];
    await sync();
    const r = await records();
    expect(r['lift_max:squat']).toBe(110);
    expect(r['lift_e1rm:squat']).toBeGreaterThan(110);
    const bodies = (await alerts()).map((n) => n.body);
    expect(bodies).toContain('New Squat heaviest set: 110.0 kg (was 100.0 kg)');
    expect(bodies.some((b) => b.startsWith('New Squat estimated 1RM'))).toBe(true);
  });

  it('opting out stops the alert but friends still see the feed post', async () => {
    await h.call('ann', 'PUT', '/api/me/notification-prefs', { prefs: { personal_record: false } });
    h.setClock('2026-10-04T08:00:00Z');
    const before = (await alerts()).length;
    const feedBefore = (await h.call<FeedEvent[]>('ben', 'GET', '/api/feed')).length;
    h.sparky.ann!.exerciseEntries = [
      squat('2026-09-30', 100),
      squat('2026-10-03', 110),
      squat('2026-10-04', 120),
    ];
    await sync();
    expect(await alerts()).toHaveLength(before);
    expect((await h.call<FeedEvent[]>('ben', 'GET', '/api/feed')).length).toBeGreaterThan(
      feedBefore,
    );
  });
});
