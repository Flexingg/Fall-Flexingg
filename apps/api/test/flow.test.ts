import type {
  ChallengeDetail,
  ChallengeResult,
  ChallengeSummary,
  FeedEvent,
  FriendsResponse,
  Invite,
  TodayResponse,
  TrendsResponse,
} from '@gauntlet/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { runSyncCycle } from '../src/scheduler.js';
import { syncUser } from '../src/services/sync.js';
import { SparkyClient } from '@gauntlet/sparky';
import { FakeSparky } from '@gauntlet/sparky/testing';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/gauntlet_test';

let app: FastifyInstance;
let ctx: AppContext;
let closeDb: () => Promise<void>;
const fake = new FakeSparky();
let clock = new Date('2026-10-02T18:00:00Z');

const maya = fake.addUser({
  id: 'u-maya',
  email: 'maya@example.com',
  password: 'pw-maya',
  name: 'Maya Rodriguez',
});
const dre = fake.addUser({
  id: 'u-dre',
  email: 'dre@example.com',
  password: 'pw-dre',
  name: 'Dre Thomas',
  twoFactorCode: '123456',
});
const sam = fake.addUser({
  id: 'u-sam',
  email: 'sam@example.com',
  password: 'pw-sam',
  name: 'Sam Kim',
});

beforeAll(async () => {
  const { db, client } = createDb(DB_URL);
  await db.execute(
    sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`,
  );
  await runMigrations(db);
  const cfg = loadConfig({
    DATABASE_URL: DB_URL,
    SPARKY_URL: fake.baseUrl,
    PUBLIC_WEB_URL: 'https://gauntlet.test',
    JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  });
  ({ app, ctx } = await buildApp({
    db,
    cfg,
    sparky: new SparkyClient({ baseUrl: fake.baseUrl, fetch: fake.fetch }),
    now: () => clock,
  }));
  closeDb = () => client.end();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

const tokens: Record<string, { access: string; refresh: string; id: string }> = {};

/** Move the clock and re-issue access tokens, as the apps do with their refresh token. */
async function setClock(iso: string) {
  clock = new Date(iso);
  for (const who of Object.keys(tokens)) {
    const r = await call<{ accessToken: string; refreshToken: string }>(
      null,
      'POST',
      '/api/auth/refresh',
      { refreshToken: tokens[who]!.refresh },
    );
    tokens[who] = { ...tokens[who]!, access: r.accessToken, refresh: r.refreshToken };
  }
}

async function call<T = unknown>(
  who: string | null,
  method: string,
  url: string,
  payload?: unknown,
  expect = 200,
): Promise<T> {
  const res = await app.inject({
    method: method as 'GET',
    url,
    payload: payload as object,
    headers: {
      'x-gauntlet-client': 'native',
      'x-timezone': 'America/Los_Angeles',
      ...(who ? { authorization: `Bearer ${tokens[who]!.access}` } : {}),
    },
  });
  if (res.statusCode !== expect)
    throw new Error(`${method} ${url} -> ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}

describe('Gauntlet end to end', () => {
  it('signs in with a password, with 2FA, and with an API key', async () => {
    const m = await call<{
      status: string;
      accessToken: string;
      refreshToken: string;
      user: { id: string; displayName: string; initials: string };
    }>(null, 'POST', '/api/auth/login', {
      method: 'password',
      email: 'maya@example.com',
      password: 'pw-maya',
    });
    expect(m.status).toBe('ok');
    expect(m.user.displayName).toBe('Maya Rodriguez');
    expect(m.user.initials).toBe('MR');
    tokens.maya = { access: m.accessToken, refresh: m.refreshToken, id: m.user.id };
    // The session token was traded for an API key and then signed out.
    expect(
      [...fake.tokens.values()].filter((t) => t.userId === 'u-maya').map((t) => t.kind),
    ).toEqual(['key']);

    await call(
      null,
      'POST',
      '/api/auth/login',
      { method: 'password', email: 'maya@example.com', password: 'nope' },
      401,
    );

    const step1 = await call<{ status: string; ticket: string }>(null, 'POST', '/api/auth/login', {
      method: 'password',
      email: 'dre@example.com',
      password: 'pw-dre',
    });
    expect(step1.status).toBe('two_factor');
    await call(null, 'POST', '/api/auth/login/2fa', { ticket: step1.ticket, code: '000000' }, 401);
    const d = await call<{ accessToken: string; refreshToken: string; user: { id: string } }>(
      null,
      'POST',
      '/api/auth/login/2fa',
      { ticket: step1.ticket, code: '123456' },
    );
    tokens.dre = { access: d.accessToken, refresh: d.refreshToken, id: d.user.id };

    const s = await call<{ accessToken: string; refreshToken: string; user: { id: string } }>(
      null,
      'POST',
      '/api/auth/login',
      { method: 'api_key', apiKey: fake.mintKey('u-sam') },
    );
    tokens.sam = { access: s.accessToken, refresh: s.refreshToken, id: s.user.id };
    await call(null, 'POST', '/api/auth/login', { method: 'api_key', apiKey: 'z'.repeat(64) }, 401);
  });

  it('rotates refresh tokens', async () => {
    const r = await call<{ accessToken: string; refreshToken: string }>(
      null,
      'POST',
      '/api/auth/refresh',
      { refreshToken: tokens.sam!.refresh },
    );
    await call(null, 'POST', '/api/auth/refresh', { refreshToken: tokens.sam!.refresh }, 401);
    tokens.sam = { ...tokens.sam!, access: r.accessToken, refresh: r.refreshToken };
    await call('sam', 'GET', '/api/me');
  });

  it('makes friends by request and by invite link', async () => {
    await call('maya', 'POST', '/api/friends/requests', { email: 'nobody@example.com' }, 404);
    expect(
      await call('maya', 'POST', '/api/friends/requests', { email: 'DRE@example.com' }),
    ).toEqual({ status: 'requested' });
    const pending = await call<FriendsResponse>('dre', 'GET', '/api/friends');
    expect(pending.requests[0]).toMatchObject({
      direction: 'incoming',
      user: { displayName: 'Maya Rodriguez' },
    });
    await call('dre', 'POST', `/api/friends/requests/${tokens.maya!.id}/accept`);

    const invite = await call<Invite>('maya', 'POST', '/api/invites', { kind: 'friend' });
    expect(invite.url).toBe(`https://gauntlet.test/j/${invite.code}`);
    const preview = await call<{ from: { displayName: string } }>(
      null,
      'GET',
      `/api/invites/${invite.code}`,
    );
    expect(preview.from.displayName).toBe('Maya Rodriguez');
    await call('sam', 'POST', `/api/invites/${invite.code}/accept`);

    const friends = await call<FriendsResponse>('maya', 'GET', '/api/friends');
    expect(friends.friends.map((f) => f.displayName).sort()).toEqual(['Dre Thomas', 'Sam Kim']);
  });

  let challengeId = '';

  it('creates a challenge, invites friends, and they respond', async () => {
    await call(
      'maya',
      'POST',
      '/api/challenges',
      {
        name: 'Bad',
        metric: 'distance',
        scoring: 'race_to_goal',
        startDate: '2026-10-02',
        endDate: '2026-10-04',
        timezone: 'America/Los_Angeles',
      },
      400,
    );

    const created = await call<ChallengeDetail>(
      'maya',
      'POST',
      '/api/challenges',
      {
        name: 'Weekend 100K',
        metric: 'distance',
        scoring: 'total',
        goal: 100,
        startDate: '2026-10-02',
        endDate: '2026-10-04',
        timezone: 'America/Los_Angeles',
        inviteUserIds: [tokens.dre!.id, tokens.sam!.id],
      },
      201,
    );
    challengeId = created.id;
    expect(created).toMatchObject({
      status: 'active',
      participantCount: 1,
      unit: 'km',
      myState: 'joined',
    });
    expect(created.invited).toHaveLength(2);

    const dreList = await call<ChallengeSummary[]>('dre', 'GET', '/api/challenges');
    expect(dreList[0]).toMatchObject({ id: challengeId, myState: 'invited' });
    await call('dre', 'POST', `/api/challenges/${challengeId}/respond`, { accept: true });
    await call('sam', 'POST', `/api/challenges/${challengeId}/respond`, { accept: true });
  });

  it('syncs every source into standings', async () => {
    // Maya: Garmin daily summaries. Dre: phone-synced distance category. Sam: workouts only.
    maya.daily.push(
      {
        entry_date: '2026-10-02',
        source_provider: 'garmin',
        total_distance_meters: 30_000,
        total_steps: 31_000,
      },
      { entry_date: '2026-10-01', source_provider: 'garmin', total_distance_meters: 99_000 }, // before the challenge
    );
    dre.categories.push({
      id: 'cat-d',
      name: 'distance',
      frequency: 'Daily',
      data_type: 'numeric',
    });
    dre.custom['cat-d'] = [
      { date: '2026-10-02', value: '41000', timestamp: '2026-10-02T23:00:00Z' },
    ];
    sam.exerciseDays.push({
      startDate: '2026-10-02',
      distanceMeters: 12_500,
      durationMinutes: 70,
      caloriesBurned: 800,
      workoutCount: 2,
    });
    sam.exerciseEntries.push(
      {
        entry_date: '2026-10-02',
        exercise_name: 'Running',
        duration_minutes: 40,
        calories_burned: 450,
      },
      {
        entry_date: '2026-10-02',
        exercise_name: 'Cycling',
        duration_minutes: 30,
        calories_burned: 350,
      },
    );

    const cycle = await runSyncCycle(ctx);
    expect(cycle.synced).toBe(3);

    const detail = await call<ChallengeDetail>('maya', 'GET', `/api/challenges/${challengeId}`);
    expect(detail.standings.map((s) => [s.user.displayName, s.rank, s.score])).toEqual([
      ['Dre Thomas', 1, 41],
      ['Maya Rodriguez', 2, 30],
      ['Sam Kim', 3, 12.5],
    ]);
    expect(detail.gap).toMatchObject({
      amount: 11,
      ahead: true,
      user: { displayName: 'Dre Thomas' },
    });
    expect(detail.daysLeft).toBe(3);

    const today = await call<TodayResponse>('maya', 'GET', '/api/me/today');
    expect(today.date).toBe('2026-10-02');
    expect(today.metrics.find((m) => m.key === 'steps')!.value).toBe(31_000);
    expect(today.featured?.myRank).toBe(2);
  });

  it('posts progress and lead changes to the feed', async () => {
    maya.daily.find((r) => r.entry_date === '2026-10-02')!.total_distance_meters = 45_000;
    await syncUser(ctx, tokens.maya!.id);
    const feed = await call<FeedEvent[]>('sam', 'GET', '/api/feed');
    const kinds = feed.map((e) => e.kind);
    expect(kinds).toContain('took_lead');
    expect(kinds).toContain('progress');
    const progress = feed.find((e) => e.kind === 'progress')!;
    expect(progress).toMatchObject({
      text: 'Maya covered 15.0 km',
      badge: '+15.0',
      source: 'garmin',
    });
    expect(feed.find((e) => e.kind === 'took_lead')!.text).toBe(
      'Maya took the lead in Weekend 100K',
    );
  });

  it('forwards Health Connect records to SparkyFitness', async () => {
    const res = await call<{ forwarded: number }>('sam', 'POST', '/api/ingest/health-connect', {
      records: [{ type: 'step', value: 12_345, date: '2026-10-02', unit: 'count' }],
    });
    expect(res.forwarded).toBe(1);
    expect(sam.ingested[0]).toMatchObject({ type: 'step', source: 'Health Connect' });
    await call(
      'sam',
      'POST',
      '/api/ingest/health-connect',
      { records: [{ type: 'Nutrition' }] },
      400,
    );
    await syncUser(ctx, tokens.sam!.id);
    const today = await call<TodayResponse>('sam', 'GET', '/api/me/today');
    expect(today.metrics.find((m) => m.key === 'steps')!.value).toBe(12_345);
  });

  it('shows trends with the weekly chart and rank history', async () => {
    const t = await call<TrendsResponse>(
      'maya',
      'GET',
      '/api/me/trends?range=week&metric=distance',
    );
    expect(t.bars).toHaveLength(7);
    expect(t.bars.map((b) => b.label).join('')).toBe('MTWTFSS');
    expect(t.bars.find((b) => b.isToday)!.value).toBe(45);
    expect(t.rankHistory?.points.at(-1)?.rank).toBe(1);
  });

  it('finalizes after the last day and offers a rematch', async () => {
    await setClock('2026-10-05T16:00:00Z'); // Oct 5 in Los Angeles
    const cycle = await runSyncCycle(ctx);
    expect(cycle.finalized).toBe(1);
    const result = await call<ChallengeResult>(
      'dre',
      'GET',
      `/api/challenges/${challengeId}/result`,
    );
    expect(result.winner?.displayName).toBe('Maya Rodriguez');
    expect(result.me).toMatchObject({ rank: 2, score: 41, bestDay: 41 });
    expect(result.challenge.status).toBe('completed');

    const rematch = await call<ChallengeDetail>(
      'dre',
      'POST',
      `/api/challenges/${challengeId}/rematch`,
      {},
      201,
    );
    expect(rematch).toMatchObject({
      name: 'Rematch: Weekend 100K',
      startDate: '2026-10-06',
      endDate: '2026-10-08',
      status: 'upcoming',
    });
    expect(rematch.invited.map((u) => u.displayName).sort()).toEqual(['Maya Rodriguez', 'Sam Kim']);
    const feed = await call<FeedEvent[]>('sam', 'GET', '/api/feed');
    expect(feed.some((e) => e.kind === 'challenge_won' && e.text === 'Maya won Weekend 100K')).toBe(
      true,
    );
  });

  it('keeps strangers out of challenges', async () => {
    const stranger = fake.addUser({
      id: 'u-x',
      email: 'x@example.com',
      password: 'pw-x',
      name: 'Xavier',
    });
    const x = await call<{ accessToken: string; refreshToken: string; user: { id: string } }>(
      null,
      'POST',
      '/api/auth/login',
      {
        method: 'password',
        email: stranger.email,
        password: 'pw-x',
      },
    );
    tokens.x = { access: x.accessToken, refresh: x.refreshToken, id: x.user.id };
    await call('x', 'GET', `/api/challenges/${challengeId}`, undefined, 403);
    await call(
      'maya',
      'POST',
      '/api/challenges',
      {
        name: 'Nope',
        metric: 'steps',
        scoring: 'total',
        startDate: '2026-10-06',
        endDate: '2026-10-07',
        timezone: 'UTC',
        inviteUserIds: [x.user.id],
      },
      400,
    );
  });

  it('flags a revoked SparkyFitness key', async () => {
    fake.revokeAllKeys('u-sam');
    const r = await syncUser(ctx, tokens.sam!.id);
    expect(r).toMatchObject({ ok: false, error: 'sparky_key_invalid' });
    const me = await call<{ sparkyKeyStatus: string }>('sam', 'GET', '/api/me');
    expect(me.sparkyKeyStatus).toBe('invalid');
    await call('sam', 'GET', '/api/sources', undefined, 409);
  });
});
