import type {
  ChallengeDetail,
  FeedComment,
  FeedEvent,
  MeUser,
  NudgeStatus,
} from '@gauntlet/shared';
import { SparkyClient } from '@gauntlet/sparky';
import { FakeSparky } from '@gauntlet/sparky/testing';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { feedEvents, notifications, nudges } from '../src/db/schema.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/gauntlet_test';
const fake = new FakeSparky();
let app: FastifyInstance;
let ctx: AppContext;
let closeDb: () => Promise<void>;
const clock = new Date('2026-10-02T18:00:00Z');
const names = {
  ann: 'Ann Lee',
  bob: 'Bob Ray',
  cy: 'Cy Moss',
  dee: 'Dee Fox',
  gus: 'Gus Hall',
  hal: 'Hal Roe',
} as const;
type Who = keyof typeof names;
const access = {} as Record<Who, string>;
const ids = {} as Record<Who, string>;

async function login(email: string, pw: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { method: 'password', email, password: pw },
    headers: { 'x-gauntlet-client': 'native', 'x-timezone': 'UTC' },
  });
  return res.json() as { accessToken: string; user: MeUser };
}

async function raw(token: string, method: string, url: string, payload?: object) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    payload,
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as unknown) : null };
}
/** Time travel without moving the clock (tokens are checked against it): age the stored nudges. */
async function ageNudges(ms: number) {
  await ctx.db
    .update(nudges)
    .set({ createdAt: sql`${nudges.createdAt} - ${ms / 1000} * interval '1 second'` });
}
const call = (who: Who, method: string, url: string, payload?: object) =>
  raw(access[who], method, url, payload);

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
    SYNC_INTERVAL_MINUTES: '0',
  });
  ({ app, ctx } = await buildApp({
    db,
    cfg,
    sparky: new SparkyClient({ baseUrl: fake.baseUrl, fetch: fake.fetch }),
    now: () => clock,
  }));
  closeDb = () => client.end();
  for (const who of Object.keys(names) as Who[]) {
    fake.addUser({ id: `u-${who}`, email: `${who}@example.com`, password: 'pw', name: names[who] });
    const body = await login(`${who}@example.com`, 'pw');
    access[who] = body.accessToken;
    ids[who] = body.user.id;
  }
  const befriend = async (a: Who, b: Who) => {
    await call(a, 'POST', '/api/friends/requests', { email: `${b}@example.com` });
    await call(b, 'POST', `/api/friends/requests/${ids[a]}/accept`);
  };
  await befriend('ann', 'bob');
  await befriend('bob', 'dee');
  await befriend('cy', 'gus');
  await befriend('cy', 'hal');
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

async function addEvent(actor: Who, challengeId: string | null = null): Promise<string> {
  const [row] = await ctx.db
    .insert(feedEvents)
    .values({
      actorId: ids[actor],
      challengeId,
      kind: 'progress',
      payload: { metric: 'distance', delta: 10.2 },
      createdAt: clock,
    })
    .returning();
  return row!.id;
}
const notesFor = (who: Who, kind: string) =>
  ctx.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, ids[who]), eq(notifications.kind, kind)));

let ev = '';

describe('reactions', () => {
  it('react, count, mine, and unreact', async () => {
    ev = await addEvent('ann');
    const r1 = await call('bob', 'POST', `/api/feed/${ev}/reactions`, { emoji: '🔥' });
    expect(r1.status).toBe(200);
    expect((r1.body as FeedEvent).reactions).toEqual([{ emoji: '🔥', count: 1, mine: true }]);
    await call('ann', 'POST', `/api/feed/${ev}/reactions`, { emoji: '🔥' });
    await call('ann', 'POST', `/api/feed/${ev}/reactions`, { emoji: '💪' });
    // Same reaction twice is still one.
    await call('ann', 'POST', `/api/feed/${ev}/reactions`, { emoji: '🔥' });

    const feedAnn = (await call('ann', 'GET', '/api/feed')).body as FeedEvent[];
    expect(feedAnn.find((e) => e.id === ev)!.reactions).toEqual([
      { emoji: '🔥', count: 2, mine: true },
      { emoji: '💪', count: 1, mine: true },
    ]);
    const feedBob = (await call('bob', 'GET', '/api/feed')).body as FeedEvent[];
    expect(feedBob.find((e) => e.id === ev)!.reactions).toEqual([
      { emoji: '🔥', count: 2, mine: true },
      { emoji: '💪', count: 1, mine: false },
    ]);

    const gone = await call(
      'ann',
      'DELETE',
      `/api/feed/${ev}/reactions/${encodeURIComponent('💪')}`,
    );
    expect((gone.body as FeedEvent).reactions).toEqual([{ emoji: '🔥', count: 2, mine: true }]);
  });

  it('only allows the fixed emoji', async () => {
    expect((await call('bob', 'POST', `/api/feed/${ev}/reactions`, { emoji: '🦄' })).status).toBe(
      400,
    );
    expect((await call('bob', 'DELETE', `/api/feed/${ev}/reactions/x`)).status).toBe(400);
  });

  it('is invisible to people who cannot see the item', async () => {
    // Dee is Bob's friend, not Ann's; Cy is a stranger.
    for (const who of ['dee', 'cy'] as const) {
      expect((await call(who, 'GET', `/api/feed/${ev}`)).status).toBe(404);
      expect((await call(who, 'POST', `/api/feed/${ev}/reactions`, { emoji: '🔥' })).status).toBe(
        404,
      );
      expect(
        (await call(who, 'DELETE', `/api/feed/${ev}/reactions/${encodeURIComponent('🔥')}`)).status,
      ).toBe(404);
      expect((await call(who, 'GET', `/api/feed/${ev}/comments`)).status).toBe(404);
      expect((await call(who, 'POST', `/api/feed/${ev}/comments`, { body: 'hi' })).status).toBe(
        404,
      );
    }
    expect((await call('bob', 'GET', '/api/feed/not-an-id')).status).toBe(404);
  });

  it('notifies the actor once per reactor, never for your own item', async () => {
    const before = (await notesFor('ann', 'reaction')).length;
    // Bob already reacted above (one notification). Toggle him a few times.
    for (let i = 0; i < 3; i++) {
      await call('bob', 'DELETE', `/api/feed/${ev}/reactions/${encodeURIComponent('🔥')}`);
      await call('bob', 'POST', `/api/feed/${ev}/reactions`, { emoji: '🔥' });
    }
    await call('bob', 'POST', `/api/feed/${ev}/reactions`, { emoji: '👏' });
    const notes = await notesFor('ann', 'reaction');
    expect(notes.length).toBe(before);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      title: 'Bob reacted 🔥',
      body: 'You covered 10.2 km',
      url: `/feed/${ev}`,
    });
    // Ann reacting to her own item notifies nobody (and not herself).
    expect((await notesFor('bob', 'reaction')).length).toBe(0);
  });
});

describe('comments', () => {
  let commentId = '';

  it('adds trimmed comments and lists them in order', async () => {
    const c = await call('bob', 'POST', `/api/feed/${ev}/comments`, { body: '  Nice run!  ' });
    expect(c.status).toBe(200);
    commentId = (c.body as FeedComment).id;
    expect(c.body).toMatchObject({
      body: 'Nice run!',
      canDelete: true,
      user: { displayName: 'Bob Ray' },
    });
    await call('ann', 'POST', `/api/feed/${ev}/comments`, { body: 'Thanks' });
    const list = (await call('ann', 'GET', `/api/feed/${ev}/comments`)).body as FeedComment[];
    expect(list.map((x) => [x.body, x.canDelete])).toEqual([
      ['Nice run!', true], // Ann's own item: she can delete anything on it
      ['Thanks', true],
    ]);
    const asBob = (await call('bob', 'GET', `/api/feed/${ev}/comments`)).body as FeedComment[];
    expect(asBob.map((x) => x.canDelete)).toEqual([true, false]);
    const feed = (await call('bob', 'GET', '/api/feed')).body as FeedEvent[];
    expect(feed.find((e) => e.id === ev)!.commentCount).toBe(2);
  });

  it('enforces 1 to 280 characters', async () => {
    expect((await call('bob', 'POST', `/api/feed/${ev}/comments`, { body: '   ' })).status).toBe(
      400,
    );
    expect((await call('bob', 'POST', `/api/feed/${ev}/comments`, { body: '' })).status).toBe(400);
    expect((await call('bob', 'POST', `/api/feed/${ev}/comments`, {})).status).toBe(400);
    expect(
      (await call('bob', 'POST', `/api/feed/${ev}/comments`, { body: 'x'.repeat(281) })).status,
    ).toBe(400);
    const ok = await call('bob', 'POST', `/api/feed/${ev}/comments`, { body: 'y'.repeat(280) });
    expect(ok.status).toBe(200);
    await call('bob', 'DELETE', `/api/comments/${(ok.body as FeedComment).id}`);
  });

  it('notifies the actor, not yourself', async () => {
    const notes = await notesFor('ann', 'comment');
    // Bob's "Nice run!" and the 280-char one; Ann's own comment made none.
    expect(notes.length).toBe(2);
    expect(notes[0]).toMatchObject({
      title: 'Bob commented',
      body: 'Nice run!',
      url: `/feed/${ev}`,
    });
    expect((await notesFor('bob', 'comment')).length).toBe(0);
  });

  it('lets the author or the item owner delete, nobody else', async () => {
    // Make Bob's friend Dee able to see it: put the item in a challenge Ann, Bob and Dee are all in.
    const shared = await addEvent('ann');
    const other = (await call('bob', 'POST', `/api/feed/${shared}/comments`, { body: 'mine' }))
      .body as FeedComment;
    expect((await call('dee', 'DELETE', `/api/comments/${other.id}`)).status).toBe(404); // can't see it
    expect((await call('cy', 'DELETE', `/api/comments/${other.id}`)).status).toBe(404);
    expect((await call('bob', 'DELETE', `/api/comments/${other.id}`)).status).toBe(204);
    expect((await call('bob', 'DELETE', `/api/comments/${other.id}`)).status).toBe(404);

    // The item's owner can remove someone else's comment.
    expect((await call('ann', 'DELETE', `/api/comments/${commentId}`)).status).toBe(204);
    const left = (await call('ann', 'GET', `/api/feed/${ev}/comments`)).body as FeedComment[];
    expect(left.map((x) => x.body)).toEqual(['Thanks']);
  });

  it('forbids a viewer who can see the item but is neither author nor owner', async () => {
    // Challenge-wide item: Gus and Hal both see Cy's item, but neither owns Ann's... use Cy's.
    const created = await call('cy', 'POST', '/api/challenges', {
      startDate: '2026-10-01',
      endDate: '2026-10-07',
      timezone: 'UTC',
      name: 'Steps',
      metric: 'steps',
      scoring: 'total',
      inviteUserIds: [ids.gus, ids.hal],
    });
    expect(created.status).toBe(201);
    challengeId = (created.body as ChallengeDetail).id;
    for (const who of ['gus', 'hal'] as const)
      await call(who, 'POST', `/api/challenges/${challengeId}/respond`, { accept: true });
    const item = await addEvent('cy', challengeId);
    const c = (await call('gus', 'POST', `/api/feed/${item}/comments`, { body: 'go go' }))
      .body as FeedComment;
    expect((await call('hal', 'DELETE', `/api/comments/${c.id}`)).status).toBe(403);
    expect((await call('cy', 'DELETE', `/api/comments/${c.id}`)).status).toBe(204);
    // Ann is outside the challenge and cannot see it.
    expect((await call('ann', 'GET', `/api/feed/${item}`)).status).toBe(404);
  });
});

let challengeId = '';

describe('nudges', () => {
  const nudge = (from: Who, to: Who, extra: object = {}) =>
    call(from, 'POST', '/api/nudges', { userId: ids[to], ...extra });
  const status = async (from: Who, to: Who) =>
    (await call(from, 'GET', `/api/nudges/status/${ids[to]}`)).body as NudgeStatus;

  it('allows a friend, with the right notification', async () => {
    expect(await status('ann', 'bob')).toEqual({ canNudge: true, retryAt: null });
    const r = await nudge('ann', 'bob');
    expect(r.status).toBe(200);
    const notes = await notesFor('bob', 'nudge');
    expect(notes[0]).toMatchObject({ title: 'Ann nudged you', body: 'Time to move!', url: '/' });
  });

  it('refuses strangers and yourself', async () => {
    expect((await nudge('ann', 'cy')).status).toBe(403);
    expect((await nudge('ann', 'dee')).status).toBe(403); // friend of a friend
    expect((await nudge('ann', 'ann')).status).toBe(400);
    expect(await status('ann', 'cy')).toEqual({ canNudge: false, retryAt: null });
    expect(await status('ann', 'ann')).toEqual({ canNudge: false, retryAt: null });
    expect((await call('ann', 'GET', '/api/nudges/status/nope')).body).toEqual({
      canNudge: false,
      retryAt: null,
    });
  });

  it('allows one nudge per person per 12 hours', async () => {
    const again = await nudge('ann', 'bob');
    expect(again.status).toBe(429);
    const retryAt = new Date(clock.getTime() + 12 * 3_600_000).toISOString();
    expect(again.body).toMatchObject({ code: 'nudge_limit', retryAt });
    expect(await status('ann', 'bob')).toEqual({ canNudge: false, retryAt });
    await ageNudges(12 * 3_600_000 + 60_000);
    expect(await status('ann', 'bob')).toEqual({ canNudge: true, retryAt: null });
    expect((await nudge('ann', 'bob')).status).toBe(200);
  });

  it('works between challenge-mates, validates the challenge, and names it', async () => {
    expect(await status('gus', 'hal')).toEqual({ canNudge: true, retryAt: null });
    // Not both in this challenge (Bob is not in it).
    expect((await nudge('gus', 'hal', { challengeId: ids.ann })).status).toBe(400);
    const wrong = await call('cy', 'POST', '/api/challenges', {
      startDate: '2026-10-01',
      endDate: '2026-10-07',
      timezone: 'UTC',
      name: 'Other',
      metric: 'steps',
      scoring: 'total',
      inviteUserIds: [ids.gus],
    });
    const otherId = (wrong.body as ChallengeDetail).id;
    await call('gus', 'POST', `/api/challenges/${otherId}/respond`, { accept: true });
    expect((await nudge('gus', 'hal', { challengeId: otherId })).status).toBe(400);
    expect((await nudge('gus', 'bob', { challengeId })).status).toBe(403);
    const ok = await nudge('gus', 'hal', { challengeId });
    expect(ok.status).toBe(200);
    const notes = await notesFor('hal', 'nudge');
    expect(notes[0]).toMatchObject({
      title: 'Gus nudged you',
      body: 'Your move in Steps',
      url: `/c/${challengeId}`,
    });
  });

  it('caps a sender at 10 nudges a day', async () => {
    const t = new Date(clock.getTime() - 60 * 60_000);
    await ctx.db
      .insert(nudges)
      .values(
        Array.from({ length: 10 }, () => ({ fromUserId: ids.bob, toUserId: ids.cy, createdAt: t })),
      );
    const r = await nudge('bob', 'ann');
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ retryAt: new Date(t.getTime() + 24 * 3_600_000).toISOString() });
    expect((await status('bob', 'ann')).canNudge).toBe(false);
    await ageNudges(24 * 3_600_000);
    expect((await status('bob', 'ann')).canNudge).toBe(true);
  });
});

describe('demo account', () => {
  it('can join in within its own cast but never reaches real people', async () => {
    const commentsBefore = (await notesFor('ann', 'comment')).length;
    const demo = await app.inject({
      method: 'POST',
      url: '/api/auth/demo',
      headers: { 'x-gauntlet-client': 'native' },
    });
    expect(demo.statusCode).toBe(200);
    const token = (demo.json() as { accessToken: string }).accessToken;
    const feed = (await raw(token, 'GET', '/api/feed')).body as FeedEvent[];
    expect(feed.length).toBeGreaterThan(0);
    const mine = feed[0]!;
    expect(
      (await raw(token, 'POST', `/api/feed/${mine.id}/reactions`, { emoji: '🔥' })).status,
    ).toBe(200);
    expect(
      (await raw(token, 'POST', `/api/feed/${mine.id}/comments`, { body: 'Nice' })).status,
    ).toBe(200);
    const friends = (await raw(token, 'GET', '/api/friends')).body as { friends: { id: string }[] };
    expect(
      (await raw(token, 'POST', '/api/nudges', { userId: friends.friends[0]!.id })).status,
    ).toBe(200);

    // Real people's items and real people are out of reach.
    const realEvent = await addEvent('ann');
    expect((await raw(token, 'GET', `/api/feed/${realEvent}`)).status).toBe(404);
    expect(
      (await raw(token, 'POST', `/api/feed/${realEvent}/reactions`, { emoji: '🔥' })).status,
    ).toBe(404);
    expect(
      (await raw(token, 'POST', `/api/feed/${realEvent}/comments`, { body: 'hi' })).status,
    ).toBe(404);
    expect((await raw(token, 'POST', '/api/nudges', { userId: ids.ann })).status).toBe(403);
    expect((await raw(token, 'GET', `/api/nudges/status/${ids.ann}`)).body).toEqual({
      canNudge: false,
      retryAt: null,
    });
    // And real people can't see the demo's items either.
    expect((await call('ann', 'GET', `/api/feed/${mine.id}`)).status).toBe(404);
    expect((await notesFor('ann', 'comment')).length).toBe(commentsBefore);
  });
});
