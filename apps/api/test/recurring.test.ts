import type { ChallengeDetail, ChallengeSummary, MeUser } from '@gauntlet/shared';
import { SparkyClient } from '@gauntlet/sparky';
import { FakeSparky, type FakeUser } from '@gauntlet/sparky/testing';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { challengeParticipants, challenges, feedEvents, notifications } from '../src/db/schema.js';
import { finalizeChallenge } from '../src/services/challenges.js';
import { syncUser } from '../src/services/sync.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/gauntlet_test';
const fake = new FakeSparky();
let app: FastifyInstance;
let ctx: AppContext;
let closeDb: () => Promise<void>;
let clock = new Date('2026-10-05T12:00:00Z');
const day = (offset: number) => new Date(Date.UTC(2026, 9, 5 + offset)).toISOString().slice(0, 10);

const people = ['ana', 'ben', 'cat', 'dan', 'eve'] as const;
type Who = (typeof people)[number];
const access = {} as Record<Who, string>;
const ids = {} as Record<Who, string>;
const sparkyOf = {} as Record<Who, FakeUser>;

async function raw(who: Who, method: string, url: string, payload?: object) {
  return app.inject({
    method: method as 'GET',
    url,
    payload,
    headers: { authorization: `Bearer ${access[who]}` },
  });
}
async function call<T = unknown>(
  who: Who,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
  expect = method === 'POST' && url === '/api/challenges' ? 201 : 200,
): Promise<T> {
  const res = await raw(who, method, url, payload);
  if (res.statusCode !== expect)
    throw new Error(`${method} ${url} -> ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}

const RED = { name: 'Red Rockets', color: '#ff6b6b' };
const BLUE = { name: 'Blue Blazers', color: '#7a9cff' };
const base = {
  name: 'Team Steps',
  metric: 'steps',
  scoring: 'total',
  timezone: 'UTC',
  startDate: day(-1),
  endDate: day(5),
};

/** Access tokens expire against the injected clock, so sign in again whenever it moves. */
async function signInAll() {
  for (const who of people) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { method: 'password', email: `${who}@example.com`, password: `pw-${who}` },
      headers: { 'x-gauntlet-client': 'native', 'x-timezone': 'UTC' },
    });
    const body = res.json() as { accessToken: string; user: MeUser };
    access[who] = body.accessToken;
    ids[who] = body.user.id;
  }
}
async function setClock(iso: string) {
  clock = new Date(iso);
  await signInAll();
}

beforeAll(async () => {
  const { db, client } = createDb(DB_URL);
  await db.execute(
    sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`,
  );
  await runMigrations(db);
  ({ app, ctx } = await buildApp({
    db,
    cfg: loadConfig({
      DATABASE_URL: DB_URL,
      SPARKY_URL: fake.baseUrl,
      PUBLIC_WEB_URL: 'https://gauntlet.test',
      JWT_SECRET: 'test-secret-test-secret-test-secret-123',
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      SYNC_INTERVAL_MINUTES: '0',
      LOGIN_RATE_LIMIT_MAX: '1000',
    }),
    sparky: new SparkyClient({ baseUrl: fake.baseUrl, fetch: fake.fetch }),
    now: () => clock,
  }));
  closeDb = () => client.end();
  for (const who of people) {
    sparkyOf[who] = fake.addUser({
      id: `u-${who}`,
      email: `${who}@example.com`,
      password: `pw-${who}`,
      name: `${who[0]!.toUpperCase()}${who.slice(1)} Tester`,
    });
  }
  await signInAll();
  for (const who of people.slice(1)) {
    await call('ana', 'POST', '/api/friends/requests', { email: `${who}@example.com` });
    await call(who, 'POST', `/api/friends/requests/${ids.ana}/accept`);
  }
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

type Row = typeof challenges.$inferSelect;
const rowOf = async (id: string): Promise<Row> =>
  (await ctx.db.select().from(challenges).where(eq(challenges.id, id)))[0]!;
const seriesRows = (seriesId: string) =>
  ctx.db.select().from(challenges).where(eq(challenges.seriesId, seriesId));

/** Steps per person on given days (offsets from the test's first day), read through a sync. */
async function setData(data: Partial<Record<Who, [number, number][]>>) {
  for (const who of people) {
    sparkyOf[who].daily.length = 0;
    for (const [offset, steps] of data[who] ?? [])
      sparkyOf[who].daily.push({ entry_date: day(offset), total_steps: steps });
    await syncUser(ctx, ids[who]);
  }
}

const weekly = (extra: object = {}) => ({ every: 'week', ...extra });
const create = (body: object, expect = 201) =>
  call<ChallengeDetail>('ana', 'POST', '/api/challenges', { ...base, ...body }, expect);
const accept = (who: Who, id: string, body: object = {}) =>
  call<ChallengeDetail>(who, 'POST', `/api/challenges/${id}/respond`, { accept: true, ...body });
const nextOf = async (id: string) => {
  const ch = await rowOf(id);
  return (await seriesRows(ch.seriesId ?? ch.id)).find(
    (r) => r.seriesRound === (ch.seriesRound ?? 1) + 1,
  );
};

describe('creating a recurring challenge', () => {
  it('is round 1 of its own series, and only for challenges with others', async () => {
    const c = await create({ recurrence: weekly() });
    const row = await rowOf(c.id);
    expect(row).toMatchObject({ seriesId: c.id, seriesRound: 1 });
    expect(row.recurrence).toEqual({ every: 'week', carryOver: true, maxRounds: null });
    expect(c.recurrence).toMatchObject({ every: 'week', carryOver: true });
    expect(c.series).toMatchObject({ round: 1, previous: [], season: [] });
    const list = await call<ChallengeSummary[]>('ana', 'GET', '/api/challenges');
    expect(list.find((x) => x.id === c.id)).toMatchObject({ recurrence: { every: 'week' } });
    await create({ recurrence: { every: 'year' } }, 400);
    await create({ recurrence: weekly({ maxRounds: 1 }) }, 400);
    await create({ recurrence: weekly(), solo: { kind: 'target' }, goal: 1000 }, 400);
    // A plain challenge isn't part of a series.
    expect((await create({})).series).toBeNull();
  });
});

describe('the next round', () => {
  it('starts exactly once when a round ends, inviting only those who joined', async () => {
    await setClock('2026-10-05T12:00:00Z');
    const c = await create({
      name: 'Weekend 100K',
      recurrence: weekly(),
      inviteUserIds: [ids.ben, ids.cat, ids.dan],
    });
    await accept('ben', c.id);
    await call('dan', 'POST', `/api/challenges/${c.id}/respond`, { accept: false });
    await setData({ ana: [[0, 5000]], ben: [[0, 9000]] });
    const round1 = await rowOf(c.id);
    await setClock(`${day(6)}T09:00:00Z`);
    // Two finalizers racing still make one round.
    const done = await Promise.all([
      finalizeChallenge(ctx, round1),
      finalizeChallenge(ctx, round1),
    ]);
    expect(done.filter(Boolean)).toHaveLength(1);
    await finalizeChallenge(ctx, await rowOf(c.id));

    const rounds = await seriesRows(c.id);
    expect(rounds).toHaveLength(2);
    const next = (await nextOf(c.id))!;
    expect(next).toMatchObject({
      name: 'Weekend 100K',
      metric: 'steps',
      scoring: 'total',
      startDate: day(6),
      endDate: day(12),
      seriesId: c.id,
      seriesRound: 2,
      createdBy: ids.ana,
      finalizedAt: null,
    });
    expect(next.recurrence).toMatchObject({ every: 'week' });
    const parts = await ctx.db
      .select()
      .from(challengeParticipants)
      .where(eq(challengeParticipants.challengeId, next.id));
    const stateOf = (who: Who) => parts.find((p) => p.userId === ids[who])?.state;
    expect(stateOf('ana')).toBe('joined');
    expect(stateOf('ben')).toBe('invited');
    expect(stateOf('cat')).toBeUndefined();
    expect(stateOf('dan')).toBeUndefined();

    const notes = await ctx.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.kind, 'new_round'), eq(notifications.userId, ids.ben)));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ url: `/c/${next.id}` });
    expect(notes[0]!.body).toContain('Round 2 of Weekend 100K starts today');
    // Cat never joined, so no invite and no ping.
    expect(
      (await ctx.db.select().from(notifications).where(eq(notifications.userId, ids.cat))).filter(
        (n) => n.kind === 'new_round',
      ),
    ).toHaveLength(0);

    // Ben accepts and the page links back to round 1.
    const seen = await accept('ben', next.id);
    expect(seen.series).toMatchObject({
      round: 2,
      previous: [{ id: c.id, round: 1 }],
    });
  });

  it('builds a season table from finished rounds', async () => {
    const [r1] = await ctx.db
      .select()
      .from(challenges)
      .where(eq(challenges.name, 'Weekend 100K'))
      .orderBy(challenges.seriesRound);
    const r2 = (await nextOf(r1!.id))!;
    await setData({ ana: [[7, 9000]], ben: [[7, 3000]] });
    await setClock(`${day(13)}T09:00:00Z`);
    expect(await finalizeChallenge(ctx, r2)).toBe(true);
    const d = await call<ChallengeDetail>('ben', 'GET', `/api/challenges/${r2.id}`);
    // Round 1: Ben won, Ana second. Round 2: Ana won, Ben second.
    expect(d.series!.round).toBe(2);
    expect(d.series!.season.map((s) => [s.user.id, s.wins, s.podiums, s.rounds]).sort()).toEqual(
      [
        [ids.ana, 1, 2, 2],
        [ids.ben, 1, 2, 2],
      ].sort(),
    );
    expect(d.series!.next).toMatchObject({ round: 3 });
    const first = await call<ChallengeDetail>('ana', 'GET', `/api/challenges/${r1!.id}`);
    expect(first.series!.next).toMatchObject({ id: r2.id, round: 2 });
    expect(first.series!.season).toHaveLength(2);
    await setClock('2026-10-05T12:00:00Z');
  });

  it('can leave carry-over off, so nobody is invited', async () => {
    const c = await create({
      name: 'No carry',
      recurrence: weekly({ carryOver: false }),
      inviteUserIds: [ids.ben],
    });
    await accept('ben', c.id);
    await setClock(`${day(6)}T09:00:00Z`);
    await finalizeChallenge(ctx, await rowOf(c.id));
    const next = (await nextOf(c.id))!;
    const parts = await ctx.db
      .select()
      .from(challengeParticipants)
      .where(eq(challengeParticipants.challengeId, next.id));
    expect(parts.map((p) => [p.userId, p.state])).toEqual([[ids.ana, 'joined']]);
    await setClock('2026-10-05T12:00:00Z');
  });

  it('stops at the max number of rounds', async () => {
    const c = await create({ name: 'Two rounds', recurrence: weekly({ maxRounds: 2 }) });
    await setClock(`${day(6)}T09:00:00Z`);
    await finalizeChallenge(ctx, await rowOf(c.id));
    const r2 = (await nextOf(c.id))!;
    expect(r2.seriesRound).toBe(2);
    await setClock(`${day(13)}T09:00:00Z`);
    await finalizeChallenge(ctx, r2);
    expect(await seriesRows(c.id)).toHaveLength(2);
    await setClock('2026-10-05T12:00:00Z');
  });

  it('stops when the creator turns repeating off, and only the creator can', async () => {
    const c = await create({ name: 'Stop me', recurrence: weekly(), inviteUserIds: [ids.ben] });
    await accept('ben', c.id);
    await call('ben', 'PATCH', `/api/challenges/${c.id}`, { recurrence: null }, 403);
    const off = await call<ChallengeDetail>('ana', 'PATCH', `/api/challenges/${c.id}`, {
      recurrence: null,
    });
    expect(off.recurrence).toBeNull();
    // It keeps its round number and series link for the history.
    expect(off.series).toMatchObject({ round: 1 });
    await setClock(`${day(6)}T09:00:00Z`);
    await finalizeChallenge(ctx, await rowOf(c.id));
    expect(await seriesRows(c.id)).toHaveLength(1);
    await setClock('2026-10-05T12:00:00Z');
  });

  it('a team challenge gets fresh empty teams, with last round’s team suggested', async () => {
    const c = await create({
      name: 'Team weekly',
      recurrence: weekly(),
      teams: {
        teams: [
          { name: 'Reds', color: '#ff6b6b' },
          { name: 'Blues', color: '#7a9cff' },
        ],
      },
      inviteUserIds: [ids.ben],
    });
    const blue = c.teams!.find((t) => t.name === 'Blues')!.id;
    await accept('ben', c.id, { teamId: blue });
    await setClock(`${day(6)}T09:00:00Z`);
    await finalizeChallenge(ctx, await rowOf(c.id));
    const next = (await nextOf(c.id))!;
    expect(next.teamScoring).toBe('avg');
    const d = await call<ChallengeDetail>('ben', 'GET', `/api/challenges/${next.id}`);
    expect(d.teams!.map((t) => t.name).sort()).toEqual(['Blues', 'Reds']);
    expect(d.teams!.every((t) => t.id !== blue)).toBe(true);
    // Only the creator is on a team so far; Ben is suggested Blues.
    expect(d.teams!.flatMap((t) => t.memberIds)).toEqual([ids.ana]);
    expect(d.teams!.find((t) => t.id === d.myTeamId)!.name).toBe('Blues');
    // Accepting without picking takes the suggestion.
    const joined = await accept('ben', next.id);
    expect(joined.teams!.find((t) => t.name === 'Blues')!.memberIds).toEqual([ids.ben]);
    await setClock('2026-10-05T12:00:00Z');
  });
});
