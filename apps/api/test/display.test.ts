import type {
  AppNotification,
  FeedEvent,
  MeUser,
  NotificationsPage,
  WorkoutsResponse,
} from '@gauntlet/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describe as describeRecord, recordBadge } from '../src/services/records.js';
import { syncUser } from '../src/services/sync.js';
import { setup, type Harness } from './notifyHarness.js';

let h: Harness;
beforeAll(async () => {
  h = await setup(['ann', 'ben']);
  await h.call('ann', 'POST', '/api/friends/requests', { email: 'ben@example.com' });
  await h.call('ben', 'POST', `/api/friends/requests/${h.ids.ann}/accept`);
});
afterAll(() => h.close());

const squat = (date: string, kg: number) => ({
  entry_date: date,
  exercise_name: 'Squat',
  exercise_source: 'liftosaur',
  duration_minutes: 0,
  sets: [{ set_type: 'Working Set', reps: 5, weight: kg }],
});

describe('display settings', () => {
  it('start unset, save, and survive notification preference changes', async () => {
    const me = await h.call<MeUser>('ann', 'GET', '/api/me');
    expect(me.settings).toMatchObject({ units: null, clock: null, locale: null });

    const saved = await h.call<MeUser>('ann', 'PATCH', '/api/me', {
      settings: { units: 'imperial', clock: '24h', locale: 'de-DE' },
    });
    expect(saved.settings).toMatchObject({ units: 'imperial', clock: '24h', locale: 'de-DE' });

    // Changing one keeps the others, and the other settings are untouched.
    const next = await h.call<MeUser>('ann', 'PATCH', '/api/me', { settings: { clock: '12h' } });
    expect(next.settings).toMatchObject({
      units: 'imperial',
      clock: '12h',
      locale: 'de-DE',
      shareEvents: true,
    });

    // Changing notification preferences leaves the display settings alone.
    await h.call('ann', 'PUT', '/api/me/notification-prefs', { prefs: { nudge: false } });
    expect((await h.call<MeUser>('ann', 'GET', '/api/me')).settings.units).toBe('imperial');
  });

  it('rejects values that are not a choice and tidies unknown locales', async () => {
    const bad = await h.raw('ann', 'PATCH', '/api/me', { settings: { units: 'furlongs' } });
    expect(bad.statusCode).toBe(400);
    const odd = await h.call<MeUser>('ben', 'PATCH', '/api/me', {
      settings: { locale: 'zz-not-real-123456' },
    });
    expect(odd.settings.locale).toBe('en-US');
  });
});

describe('texts follow the reader', () => {
  it('words a personal-record notification in the owner’s units, and the feed in each reader’s', async () => {
    await h.call('ann', 'PATCH', '/api/me', { settings: { units: 'imperial', locale: 'en-US' } });
    h.setClock('2026-10-02T18:00:00Z');
    h.sparky.ann!.exerciseEntries = [squat('2026-09-30', 100)];
    await syncUser(h.ctx, h.ids.ann!);
    h.setClock('2026-10-03T06:00:00Z');
    h.sparky.ann!.exerciseEntries = [squat('2026-09-30', 100), squat('2026-10-03', 110)];
    await syncUser(h.ctx, h.ids.ann!);

    const mine = (await h.call<NotificationsPage>('ann', 'GET', '/api/notifications')).items.filter(
      (n: AppNotification) => n.kind === 'personal_record',
    );
    expect(mine.map((n) => n.body)).toContain('New Squat heaviest set: 242.5 lb (was 220.5 lb)');

    const badge = async (who: string) =>
      (await h.call<FeedEvent[]>(who, 'GET', '/api/feed')).find(
        (e) => e.kind === 'personal_record' && e.text.includes('heaviest'),
      )!.badge;
    expect(await badge('ann')).toBe('242.5 lb');
    // Ben never chose, so he reads metric.
    expect(await badge('ben')).toBe('110.0 kg');
  });

  it('words workout summaries in the reader’s units', async () => {
    h.sparky.ann!.exerciseEntries = [
      {
        id: 'run-1',
        entry_date: '2026-10-02',
        exercise_name: 'running',
        duration_minutes: 40,
        calories_burned: 450,
        exercise_source: 'garmin',
        distance: 10,
        start_time: '2026-10-02T07:30:00Z',
      },
    ];
    h.setClock('2026-10-03T07:00:00Z');
    const list = await h.call<WorkoutsResponse>('ann', 'GET', '/api/me/workouts');
    expect(list.workouts[0]!.summary).toContain('6.2 mi');
    await h.call('ann', 'PATCH', '/api/me', { settings: { units: 'metric' } });
    const metric = await h.call<WorkoutsResponse>('ann', 'GET', '/api/me/workouts');
    expect(metric.workouts[0]!.summary).toContain('10 km');
  });
});

describe('record wording helpers', () => {
  it('keeps the raw value so each reader gets their own units', () => {
    const alert = describeRecord({ key: 'distance_day', value: 12.4, date: '2026-10-01' }, 10, {
      units: 'imperial',
      locale: 'en-US',
    })!;
    expect(alert).toMatchObject({ value: 12.4, unit: 'km', decimals: 1, badge: '7.7 mi' });
    expect(alert.text).toBe('New best distance day: 7.7 mi (was 6.2 mi)');
    const payload = { value: alert.value, unit: alert.unit, decimals: alert.decimals };
    expect(recordBadge(payload, { units: 'metric', locale: 'en-US' })).toBe('12.4 km');
    // Records saved before this kept only the text.
    expect(recordBadge({ badge: '18,204' })).toBe('18,204');
    expect(recordBadge({})).toBeNull();
  });
});
