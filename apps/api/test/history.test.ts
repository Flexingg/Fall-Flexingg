/**
 * History import: years of data come in newest first, in chunks, quietly (no feed posts, no
 * old-record alerts, one badge summary); one job per person; cancel, resume and failure handling;
 * the demo account is blocked; and the normal sync leaves older history alone.
 */
import type {
  FeedEvent,
  HistoryStatus,
  NotificationsPage,
  StartHistoryRequest,
} from '@gauntlet/shared';
import { and, eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  badgeDefinitions,
  dailyMetrics,
  feedEvents,
  personalRecords,
  serverState,
  userBadges,
  users,
} from '../src/db/schema.js';
import { checkBadges } from '../src/services/badges/engine.js';
import { findDemoUser, refreshDemo } from '../src/services/demo.js';
import {
  historyTuning,
  resumeHistoryImports,
  whenHistoryDone,
} from '../src/services/historyImport.js';
import { refreshPersonalRecords } from '../src/services/records.js';
import { syncUser } from '../src/services/sync.js';
import { setup, type Harness } from './notifyHarness.js';

let h: Harness;
const ann = () => h.ids.ann!;

beforeAll(async () => {
  historyTuning.paceMs = 0;
  historyTuning.rateBackoffMs = 0;
  h = await setup(['ann', 'ben'], {
    env: {
      OAUTH_STRAVA_CLIENT_ID: 'sid',
      OAUTH_STRAVA_CLIENT_SECRET: 'ssecret',
      OAUTH_POLAR_CLIENT_ID: 'pid',
      OAUTH_POLAR_CLIENT_SECRET: 'psecret',
    },
  });
});
afterAll(() => h.close());

const NOW = '2026-10-02T18:00:00Z';

/** A step reading every week since 2022, plus one huge day in 2023. */
const seedYears = () => {
  const rows = [];
  for (let d = new Date('2022-01-03T00:00:00Z'); d < new Date('2026-08-01T00:00:00Z');) {
    rows.push({
      entry_date: d.toISOString().slice(0, 10),
      source_provider: 'garmin',
      total_steps: 6000,
    });
    d = new Date(d.getTime() + 7 * 86_400_000);
  }
  rows.push({ entry_date: '2023-05-05', source_provider: 'garmin', total_steps: 40_000 });
  h.sparky.ann!.daily = rows;
};

const linkGarmin = () => {
  h.sparky.ann!.garmin = { linkedAt: NOW, syncs: 0 };
};
const addApp = (type: string, extra: Record<string, unknown> = {}) =>
  h.sparky.ann!.providers.push({
    id: `prov-${type}`,
    provider_type: type,
    provider_name: type,
    is_active: true,
    is_public: false,
    has_token: true,
    sync_frequency: 'manual',
    last_sync_at: null,
    app_key: type === 'hevy' ? 'good-hevy-key' : undefined,
    syncs: 0,
    ...extra,
  });

const status = () => h.call<HistoryStatus>('ann', 'GET', '/api/me/history-import');
const start = (body: StartHistoryRequest) =>
  h.call<HistoryStatus>('ann', 'POST', '/api/me/history-import', body);
const finish = async () => {
  await whenHistoryDone(ann());
  return status();
};
const notes = async (kind: string) =>
  (await h.call<NotificationsPage>('ann', 'GET', '/api/notifications')).items.filter(
    (n) => n.kind === kind,
  );
const feedOf = async () =>
  (await h.call<FeedEvent[]>('ann', 'GET', '/api/feed')).filter((e) => e.kind !== 'joined');
const stepsOn = async (date: string) =>
  (
    await h.ctx.db
      .select()
      .from(dailyMetrics)
      .where(
        and(
          eq(dailyMetrics.userId, ann()),
          eq(dailyMetrics.date, date),
          eq(dailyMetrics.metric, 'steps'),
        ),
      )
  )[0]?.value;

beforeEach(async () => {
  await whenHistoryDone(ann());
  h.setClock(NOW);
  h.fake.failSync = undefined;
  h.fake.syncLog = [];
  h.fake.latencyMs = {};
  h.fake.calls = [];
  h.sparky.ann!.garmin = undefined;
  h.sparky.ann!.providers = [];
  h.sparky.ann!.daily = [];
  h.sparky.ann!.exerciseEntries = [];
  await h.ctx.db.delete(feedEvents);
  await h.ctx.db.execute(sql`delete from notifications`);
  await h.ctx.db.delete(dailyMetrics);
  await h.ctx.db.delete(personalRecords);
  await h.ctx.db.delete(userBadges);
  await h.ctx.db.delete(badgeDefinitions);
  await h.ctx.db.delete(serverState).where(like(serverState.key, 'history:%'));
  // Past the first badge check, as a person who has used the app for a while is.
  await h.ctx.db
    .insert(serverState)
    .values({ key: `badge_init:${ann()}`, value: true })
    .onConflictDoNothing();
});

describe('importing years of history', () => {
  it('pulls Garmin in chunks, newest first, then reads it all quietly', async () => {
    seedYears();
    linkGarmin();
    await h.ctx.db.insert(badgeDefinitions).values({
      key: 'long-haul',
      name: 'Long Haul',
      description: 'Walk {n} steps in total.',
      family: 'movement',
      icon: 'shoe',
      rule: { type: 'lifetime_total', metric: 'steps', tiers: [100_000, 500_000] },
      status: 'live',
      origin: 'admin',
    });

    const started = await start({ years: 5 });
    expect(started).toMatchObject({ running: true, state: 'running' });
    expect(started.range).toMatchObject({ end: '2026-10-02', days: 1826 });
    expect(started.steps.map((s) => s.source)).toEqual(['garmin', 'sparky']);

    const done = await finish();
    expect(done).toMatchObject({ running: false, state: 'done', error: null });
    expect(done.steps.map((s) => [s.source, s.state])).toEqual([
      ['garmin', 'done'],
      ['sparky', 'done'],
    ]);
    expect(done.steps[0]!.doneDays).toBe(done.steps[0]!.totalDays);

    // Garmin was asked newest first, in windows of at most 30 days that join up exactly.
    const log = h.fake.syncLog.filter((s) => s.route === 'garmin');
    expect(log[0]!.endDate).toBe('2026-10-02');
    expect(log.at(-1)!.startDate).toBe(done.range!.start);
    for (const [i, call] of log.entries()) {
      expect(
        (Date.parse(call.endDate) - Date.parse(call.startDate)) / 86_400_000,
      ).toBeLessThanOrEqual(29);
      if (i > 0) {
        expect(call.endDate < log[i - 1]!.startDate).toBe(true);
        expect((Date.parse(log[i - 1]!.startDate) - Date.parse(call.endDate)) / 86_400_000).toBe(1);
      }
    }
    // Gauntlet read SparkyFitness in windows of at most 90 days, so far fewer reports calls.
    const reads = h.fake.calls.filter((c) => c.startsWith('GET /api/reports')).length;
    expect(reads).toBe(Math.ceil(1828 / 90));

    // Old days are stored, and the big day became a record without any noise.
    expect(await stepsOn('2022-01-03')).toBe(6000);
    expect(await stepsOn('2023-05-05')).toBe(40_000);
    const [rec] = await h.ctx.db
      .select()
      .from(personalRecords)
      .where(and(eq(personalRecords.userId, ann()), eq(personalRecords.key, 'steps_day')));
    expect(rec).toMatchObject({ value: 40_000, date: '2023-05-05' });
    expect(await notes('personal_record')).toHaveLength(0);
    expect(await feedOf()).toHaveLength(0);

    // One summary notification for the badge the history unlocked; no per-badge celebration.
    const badgeNotes = await notes('badge');
    expect(badgeNotes).toHaveLength(1);
    expect(badgeNotes[0]!.body).toMatch(/^Your history unlocked 1 badge/);
    const earned = await h.ctx.db.select().from(userBadges).where(eq(userBadges.userId, ann()));
    expect(earned.length).toBeGreaterThanOrEqual(1);
    expect(earned.every((b) => b.seenAt && b.backfilled)).toBe(true);

    expect(done.summary).toMatchObject({
      oldestBefore: null,
      newBadges: 1,
    });
    expect(done.summary!.oldestAfter! <= '2022-01-03').toBe(true);
    expect(done.summary!.newDays).toBeGreaterThan(200);
    expect(done.summary!.newRecords).toBeGreaterThanOrEqual(1);
  });

  it('keeps imported history when the normal sync runs afterwards', async () => {
    seedYears();
    await start({ days: 1500, sources: ['sparky'] });
    await finish();
    expect(await stepsOn('2023-05-05')).toBe(40_000);
    const before = (
      await h.ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(dailyMetrics)
        .where(and(eq(dailyMetrics.userId, ann()), sql`${dailyMetrics.date} < '2026-07-01'`))
    )[0]!.n;
    const r = await syncUser(h.ctx, ann());
    expect(r.ok).toBe(true);
    const after = (
      await h.ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(dailyMetrics)
        .where(and(eq(dailyMetrics.userId, ann()), sql`${dailyMetrics.date} < '2026-07-01'`))
    )[0]!.n;
    expect(after).toBe(before);
  });

  it('lists every connected app, and says what each cannot do', async () => {
    linkGarmin();
    addApp('strava');
    addApp('polar');
    addApp('hevy');
    const s = await start({ days: 90 });
    expect(s.steps.map((x) => [x.source, x.state])).toEqual([
      ['garmin', 'waiting'],
      ['strava', 'waiting'],
      ['polar', 'skipped'],
      ['hevy', 'waiting'],
      ['sparky', 'waiting'],
    ]);
    // Polar's own limit is shown on its row.
    expect(s.steps.find((x) => x.source === 'polar')!.note).toMatch(/4 weeks/);
    await finish();
  });

  it('asks each app the way it can answer: windows, one full pull, or not at all', async () => {
    linkGarmin();
    addApp('strava');
    addApp('polar');
    addApp('hevy');
    await start({ days: 400 });
    const done = await finish();
    expect(done.state).toBe('done');
    const strava = h.fake.syncLog.filter((s) => s.route === 'strava');
    expect(strava).toHaveLength(Math.ceil(401 / 90));
    expect(h.fake.syncLog.filter((s) => s.route === 'polar')).toHaveLength(0);
    const hevy = h.fake.syncLog.filter((s) => s.route === 'hevy');
    expect(hevy).toHaveLength(1);
    expect(hevy[0]!.full).toBe(true);

    h.fake.syncLog = [];
    await start({ days: 100, sources: ['sparky'] });
    await finish();
    expect(h.fake.syncLog).toHaveLength(0);
  });

  it('rejects bad requests', async () => {
    for (const body of [
      {},
      { days: 3000 },
      { years: 6 },
      { years: 1, days: 10 },
      { days: 30, sources: ['nope'] },
    ])
      expect((await h.raw('ann', 'POST', '/api/me/history-import', body)).statusCode).toBe(400);
    const none = await h.raw('ann', 'POST', '/api/me/history-import', {
      days: 30,
      sources: ['garmin'],
    });
    expect(none.statusCode).toBe(400);
    expect((none.json() as { code: string }).code).toBe('nothing_to_import');
  });
});

describe('problems along the way', () => {
  it('carries on when Garmin rate-limits: the row says so, the rest still imports', async () => {
    seedYears();
    linkGarmin();
    let n = 0;
    h.fake.failSync = () =>
      ++n > 2 ? { status: 500, error: 'Failed to sync Garmin: 429 Too Many Requests' } : null;
    await start({ years: 2 });
    const done = await finish();
    expect(done.state).toBe('done');
    const g = done.steps.find((s) => s.source === 'garmin')!;
    expect(g.state).toBe('failed');
    expect(g.error).toMatch(/limiting requests/);
    expect(g.error).toMatch(/Imported back to/);
    expect(done.steps.find((s) => s.source === 'sparky')!.state).toBe('done');
    expect(await stepsOn('2025-10-06')).toBe(6000);
  });

  it('skips a chunk that keeps failing but finishes the rest', async () => {
    linkGarmin();
    h.fake.failSync = (_r, range) =>
      range.endDate === '2026-09-02' ||
      (range.startDate <= '2026-08-20' && range.endDate >= '2026-08-20')
        ? { status: 500, error: 'Failed to sync Garmin: something odd' }
        : null;
    await start({ days: 200 });
    const done = await finish();
    const g = done.steps.find((s) => s.source === 'garmin')!;
    expect(g.state).toBe('done');
    expect(g.error).toMatch(/1 stretch of history couldn't be imported/);
    expect(g.doneDays).toBe(g.totalDays);
  });

  it('fails the job and flags the key when SparkyFitness rejects it part way', async () => {
    h.sparky.ben!.garmin = { linkedAt: NOW, syncs: 0 };
    h.fake.failSync = () => ({ status: 401, error: 'Authentication required.' });
    await h.call<HistoryStatus>('ben', 'POST', '/api/me/history-import', { days: 60 });
    await whenHistoryDone(h.ids.ben!);
    const done = await h.call<HistoryStatus>('ben', 'GET', '/api/me/history-import');
    expect(done.state).toBe('failed');
    expect(done.error).toMatch(/expired/);
    const [u] = await h.ctx.db.select().from(users).where(eq(users.id, h.ids.ben!));
    expect(u!.keyStatus).toBe('invalid');
    // And a new import is refused until they sign in again.
    const again = await h.raw('ben', 'POST', '/api/me/history-import', { days: 60 });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { code: string }).code).toBe('sparky_key_invalid');
  });
});

describe('one job at a time, cancel, restart', () => {
  it('refuses a second import while one is running, and cancel stops it', async () => {
    linkGarmin();
    h.fake.latencyMs['u-ann'] = 40;
    await start({ years: 5 });
    const again = await h.raw('ann', 'POST', '/api/me/history-import', { years: 1 });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { code: string }).code).toBe('history_running');
    expect((await status()).running).toBe(true);

    await new Promise((r) => setTimeout(r, 250));
    const cancelled = await h.call<HistoryStatus>('ann', 'DELETE', '/api/me/history-import');
    expect(cancelled.state).toBe('cancelled');
    const done = await finish();
    expect(done).toMatchObject({ running: false, state: 'cancelled' });
    expect(done.steps.map((s) => s.state)).toContain('cancelled');
    // It stopped part way.
    expect(h.fake.syncLog.length).toBeGreaterThan(0);
    expect(h.fake.syncLog.length).toBeLessThan(61);

    // And a new one can be started afterwards.
    h.fake.latencyMs = {};
    expect(await start({ days: 30, sources: ['sparky'] })).toMatchObject({ running: true });
    expect((await finish()).state).toBe('done');
  });

  it('resumes after a restart from where it stopped, newest chunks not repeated', async () => {
    seedYears();
    await start({ days: 400, sources: ['sparky'] });
    const first = await finish();
    // Fake a crash: running again, with the newest chunks already done.
    const [row] = await h.ctx.db
      .select()
      .from(serverState)
      .where(eq(serverState.key, `history:${ann()}`));
    const job = row!.value as Record<string, unknown> & {
      steps: { state: string; doneDays: number }[];
      cursors: Record<string, string>;
    };
    job.state = 'running';
    job.steps[0]!.state = 'running';
    job.steps[0]!.doneDays = 0;
    job.cursors = { sparky: '2026-01-01' };
    await h.ctx.db
      .update(serverState)
      .set({ value: job })
      .where(eq(serverState.key, `history:${ann()}`));

    // Until the server picks it up, it reads as interrupted, not running.
    expect(await status()).toMatchObject({ running: false, state: 'interrupted' });

    h.fake.calls = [];
    expect(await resumeHistoryImports(h.ctx)).toBe(1);
    const done = await finish();
    expect(done.state).toBe('done');
    const reads = h.fake.calls.filter((c) => c.startsWith('GET /api/reports')).length;
    // Only the days before 2026-01-01 (about 3.5 months back to the start): two windows, not five.
    expect(reads).toBeLessThan(Math.ceil(first.range!.days / 90) + 1);
    expect(reads).toBeLessThanOrEqual(3);
  });

  it('gives up after repeated restarts and says so', async () => {
    seedYears();
    await start({ days: 100, sources: ['sparky'] });
    await finish();
    await h.ctx.db.execute(
      sql`update server_state set value = jsonb_set(jsonb_set(value, '{state}', '"running"'), '{resumes}', '3') where key = ${`history:${ann()}`}`,
    );
    expect(await resumeHistoryImports(h.ctx)).toBe(0);
    const s = await status();
    expect(s).toMatchObject({ running: false, state: 'interrupted' });
    expect(s.error).toMatch(/Start it again/);
  });
});

describe('the demo account', () => {
  it('cannot start or cancel an import, and sees nothing', async () => {
    await refreshDemo(h.ctx);
    const demo = (await findDemoUser(h.ctx))!;
    h.ids.demo = demo.id;
    const post = await h.raw('demo', 'POST', '/api/me/history-import', { years: 1 });
    expect(post.statusCode).toBe(403);
    expect((post.json() as { code: string }).code).toBe('demo_account');
    expect((await h.raw('demo', 'DELETE', '/api/me/history-import')).statusCode).toBe(403);
    expect((await h.raw('demo', 'GET', '/api/me/history-import')).json()).toMatchObject({
      state: 'idle',
    });
  });
});

describe('records from old days', () => {
  const setRecord = async (value: number, ago: number) =>
    h.ctx.db
      .insert(personalRecords)
      .values({
        userId: ann(),
        key: 'steps_day',
        value,
        date: '2026-01-01',
        updatedAt: new Date(Date.parse(NOW) - ago),
      })
      .onConflictDoUpdate({
        target: [personalRecords.userId, personalRecords.key],
        set: { value, updatedAt: new Date(Date.parse(NOW) - ago) },
      });
  const put = (date: string, value: number) =>
    h.ctx.db
      .insert(dailyMetrics)
      .values({ userId: ann(), date, metric: 'steps', value })
      .onConflictDoUpdate({
        target: [dailyMetrics.userId, dailyMetrics.date, dailyMetrics.metric],
        set: { value },
      });

  it('files a record set long ago without an alert, but still announces a fresh one', async () => {
    await setRecord(10_000, 86_400_000);
    await put('2023-05-05', 40_000);
    const quiet = await refreshPersonalRecords(h.ctx, ann(), { quietBefore: '2026-09-29' });
    expect(quiet.alerts).toBe(0);
    expect(quiet.updated).toBeGreaterThanOrEqual(1);
    expect(await notes('personal_record')).toHaveLength(0);
    expect(
      (await h.ctx.db.select().from(personalRecords).where(eq(personalRecords.userId, ann())))[0]!
        .value,
    ).toBe(40_000);

    await setRecord(10_000, 86_400_000);
    await h.ctx.db.delete(dailyMetrics);
    await put('2026-10-01', 41_000);
    const loud = await refreshPersonalRecords(h.ctx, ann(), { quietBefore: '2026-09-29' });
    expect(loud.alerts).toBe(1);
    expect(await notes('personal_record')).toHaveLength(1);
  });
});

describe('badges from history', () => {
  it('announces once even on a first-ever check', async () => {
    await h.ctx.db.delete(serverState).where(eq(serverState.key, `badge_init:${ann()}`));
    await h.ctx.db.insert(badgeDefinitions).values({
      key: 'long-haul',
      name: 'Long Haul',
      description: 'Walk {n} steps in total.',
      family: 'movement',
      icon: 'shoe',
      rule: { type: 'lifetime_total', metric: 'steps', tiers: [1000] },
      status: 'live',
      origin: 'admin',
    });
    await h.ctx.db
      .insert(dailyMetrics)
      .values({ userId: ann(), date: '2023-01-01', metric: 'steps', value: 5000 });
    const got = await checkBadges(h.ctx, ann(), { reason: 'sync', history: true });
    expect(got).toHaveLength(1);
    const n = await notes('badge');
    expect(n).toHaveLength(1);
    expect(n[0]!.body).toMatch(/Your history unlocked 1 badge/);
  });
});
