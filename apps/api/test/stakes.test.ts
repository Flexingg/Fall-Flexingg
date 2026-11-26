import type { ChallengeDetail, InvitePreview, MeUser } from '@gauntlet/shared';
import { SparkyClient } from '@gauntlet/sparky';
import { FakeSparky, type FakeUser } from '@gauntlet/sparky/testing';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { challenges, notifications } from '../src/db/schema.js';
import { finalizeChallenge } from '../src/services/challenges.js';
import { syncUser } from '../src/services/sync.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/gauntlet_test';
const fake = new FakeSparky();
let app: FastifyInstance;
let ctx: AppContext;
let closeDb: () => Promise<void>;
let clock = new Date('2026-10-05T12:00:00Z');
const day = (offset: number) => new Date(Date.UTC(2026, 9, 5 + offset)).toISOString().slice(0, 10);

const people = ['ana', 'ben', 'cat', 'dan'] as const;
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

const COFFEE = 'Loser buys coffee';
const base = {
  name: 'Step Duel',
  metric: 'steps',
  scoring: 'total',
  timezone: 'UTC',
  startDate: day(-1),
  endDate: day(5),
};
const create = (body: object, expect = 201) =>
  call<ChallengeDetail>('ana', 'POST', '/api/challenges', { ...base, ...body }, expect);
const get = (who: Who, id: string) => call<ChallengeDetail>(who, 'GET', `/api/challenges/${id}`);
const patch = (who: Who, id: string, body: object, expect = 200) =>
  call<ChallengeDetail>(who, 'PATCH', `/api/challenges/${id}`, body, expect);

/** Everyone's steps on one day, read the way the real app reads them: through a sync. */
async function setData(date: string, data: Partial<Record<Who, number>>) {
  for (const who of people) {
    sparkyOf[who].daily.length = 0;
    if (data[who] != null) sparkyOf[who].daily.push({ entry_date: date, total_steps: data[who] });
    await syncUser(ctx, ids[who]);
  }
}
async function finalize(id: string) {
  const [row] = await ctx.db.select().from(challenges).where(eq(challenges.id, id));
  expect(await finalizeChallenge(ctx, row!)).toBe(true);
}
/** Create, accept, score on day 0 and finish a challenge. Ends with the clock on day 6. */
async function playOut(
  body: object,
  scores: Partial<Record<Who, number>>,
  opts: { accept?: Record<string, string> } = {},
) {
  await setClock('2026-10-05T12:00:00Z');
  const others = Object.keys(scores).filter((w) => w !== 'ana') as Who[];
  const c = await create({ inviteUserIds: others.map((w) => ids[w]), ...body });
  for (const w of others)
    await call(w, 'POST', `/api/challenges/${c.id}/respond`, {
      accept: true,
      ...(opts.accept?.[w] ? { teamId: opts.accept[w] } : {}),
    });
  await setData(day(0), scores);
  await setClock(`${day(6)}T12:00:00Z`);
  await finalize(c.id);
  return c;
}

describe('creating and editing a side bet', () => {
  it('stores a trimmed stake, and treats an empty one as none', async () => {
    await setClock('2026-10-05T12:00:00Z');
    const c = await create({ stake: `  Loser   buys coffee  ` });
    expect(c.stake).toBe(COFFEE);
    expect((await create({ stake: '   ' })).stake).toBeNull();
    expect((await create({ stake: null })).stake).toBeNull();
    expect((await create({})).stake).toBeNull();
  });

  it('refuses long stakes, links and solo stakes', async () => {
    await create({ stake: 'x'.repeat(81) }, 400);
    expect((await create({ stake: 'y'.repeat(80) })).stake).toHaveLength(80);
    await create({ stake: 'Winner takes https://example.com' }, 400);
    await create({ stake: 'see www.example.com' }, 400);
    await create(
      { stake: COFFEE, solo: { kind: 'target' }, goal: 1000, scoring: 'race_to_goal' },
      400,
    );
  });

  it('lets only the creator change it, and only before the start', async () => {
    const c = await create({ startDate: day(2), endDate: day(8), inviteUserIds: [ids.ben] });
    await call('ben', 'POST', `/api/challenges/${c.id}/respond`, { accept: true });
    await patch('ben', c.id, { stake: COFFEE }, 403);
    expect((await patch('ana', c.id, { stake: ` ${COFFEE} ` })).stake).toBe(COFFEE);
    expect((await get('ben', c.id)).stake).toBe(COFFEE);
    await patch('ana', c.id, { stake: 'https://evil.example' }, 400);
    // Other edits leave it alone; null removes it.
    expect((await patch('ana', c.id, { name: 'Renamed' })).stake).toBe(COFFEE);
    expect((await patch('ana', c.id, { stake: null })).stake).toBeNull();
    await patch('ana', c.id, { stake: COFFEE });

    await setClock(`${day(2)}T12:00:00Z`);
    await patch('ana', c.id, { stake: 'Loser posts a selfie' }, 400);
    await patch('ana', c.id, { stake: null }, 400);
    expect((await get('ana', c.id)).stake).toBe(COFFEE);
    // Saving the same text again is not a change.
    await patch('ana', c.id, { stake: COFFEE });
    await setClock('2026-10-05T12:00:00Z');
  });

  it('shows the stake in the invite preview and the challenge list', async () => {
    const c = await create({ stake: COFFEE });
    const inv = await call<{ code: string }>('ana', 'POST', '/api/invites', {
      kind: 'challenge',
      challengeId: c.id,
    });
    const preview = await call<InvitePreview>('ben', 'GET', `/api/invites/${inv.code}`);
    expect(preview.challenge?.stake).toBe(COFFEE);
    const list = await call<{ id: string; stake?: string | null }[]>(
      'ana',
      'GET',
      '/api/challenges',
    );
    expect(list.find((x) => x.id === c.id)?.stake).toBe(COFFEE);
  });

  it('is fine on a public challenge', async () => {
    await call('ana', 'PATCH', '/api/me', { visibility: 'public', handle: 'ana' });
    const c = await create({ stake: COFFEE, visibility: 'public' });
    expect(c.visibility).toBe('public');
    expect(c.stake).toBe(COFFEE);
  });
});

describe('who owes a side bet', () => {
  it('is last place, told once in the result notification, and settled by the winner or creator', async () => {
    // Ana is the creator and finishes last; Cat wins.
    const c = await playOut({ stake: COFFEE }, { ana: 1000, ben: 2000, cat: 3000 });
    const d = await get('ben', c.id);
    expect(d.status).toBe('completed');
    expect(d.stakeInfo).toMatchObject({ settledAt: null, canSettle: false });
    expect(d.stakeInfo!.owedBy.map((u) => u.id)).toEqual([ids.ana]);
    expect(d.stakeInfo!.owedTo.map((u) => u.id)).toEqual([ids.cat]);
    expect((await get('cat', c.id)).stakeInfo!.canSettle).toBe(true);
    expect((await get('ana', c.id)).stakeInfo!.canSettle).toBe(true);

    // One notification each; only the loser is told what they owe.
    const notes = (await ctx.db.select().from(notifications)).filter(
      (n) =>
        n.kind === 'challenge_finished' &&
        (n.payload as { challengeId?: string }).challengeId === c.id,
    );
    expect(notes).toHaveLength(3);
    const body = (w: Who) => notes.find((n) => n.userId === ids[w])!.body;
    expect(body('ana')).toBe(`You finished 3rd of 3. You owe: ${COFFEE}`);
    expect(body('cat')).toBe('You won!');
    expect(body('ben')).not.toContain('owe');

    // Settling: not the middle finisher, yes the winner, undo by the creator.
    const settle = (who: Who, payload: object = {}, expect = 200) =>
      call<ChallengeDetail>(who, 'POST', `/api/challenges/${c.id}/stake/settle`, payload, expect);
    await settle('ben', {}, 403);
    const paid = await settle('cat');
    expect(paid.stakeInfo!.settledAt).toBeTruthy();
    const again = await settle('ana');
    expect(again.stakeInfo!.settledAt).toBe(paid.stakeInfo!.settledAt);
    expect((await settle('ana', { settled: false })).stakeInfo!.settledAt).toBeNull();
    await settle('dan', {}, 403);
  });

  it('has no loser in a three-way tie, and two losers when two tie for last', async () => {
    const tie = await playOut({ stake: COFFEE }, { ana: 2000, ben: 2000, cat: 2000 });
    expect((await get('ana', tie.id)).stakeInfo).toMatchObject({ owedBy: [] });
    const two = await playOut({ stake: COFFEE }, { ana: 3000, ben: 1000, cat: 1000 });
    const d = await get('ana', two.id);
    expect(d.stakeInfo!.owedBy.map((u) => u.id).sort()).toEqual([ids.ben, ids.cat].sort());
    expect(d.stakeInfo!.owedTo.map((u) => u.id)).toEqual([ids.ana]);
  });

  it('is the losing team in a team challenge, and tells every member', async () => {
    const teams = {
      scoring: 'avg',
      teams: [
        { name: 'Red', color: '#ff6b6b' },
        { name: 'Blue', color: '#7a9cff' },
      ],
    };
    await setClock('2026-10-05T12:00:00Z');
    const c = await create({ stake: COFFEE, teams, inviteUserIds: [ids.ben, ids.cat, ids.dan] });
    const red = c.teams!.find((t) => t.name === 'Red')!.id;
    const blue = c.teams!.find((t) => t.name === 'Blue')!.id;
    await call('ben', 'POST', `/api/challenges/${c.id}/respond`, { accept: true, teamId: red });
    await call('cat', 'POST', `/api/challenges/${c.id}/respond`, { accept: true, teamId: blue });
    await call('dan', 'POST', `/api/challenges/${c.id}/respond`, { accept: true, teamId: blue });
    await setData(day(0), { ana: 12000, ben: 8000, cat: 5000, dan: 5000 });
    await setClock(`${day(6)}T12:00:00Z`);
    await finalize(c.id);
    const d = await get('ana', c.id);
    expect(d.stakeInfo!.owedBy.map((u) => u.id).sort()).toEqual([ids.cat, ids.dan].sort());
    expect(d.stakeInfo!.owedTo.map((u) => u.id).sort()).toEqual([ids.ana, ids.ben].sort());
    const notes = (await ctx.db.select().from(notifications)).filter(
      (n) =>
        n.kind === 'challenge_finished' &&
        (n.payload as { challengeId?: string }).challengeId === c.id,
    );
    for (const w of ['cat', 'dan'] as const)
      expect(notes.find((n) => n.userId === ids[w])!.body).toContain(`You owe: ${COFFEE}`);
    for (const w of ['ana', 'ben'] as const)
      expect(notes.find((n) => n.userId === ids[w])!.body).not.toContain('owe');
  });

  it('only settles a finished challenge that has a side bet', async () => {
    await setClock('2026-10-05T12:00:00Z');
    const live = await create({ stake: COFFEE });
    await call('ana', 'POST', `/api/challenges/${live.id}/stake/settle`, {}, 400);
    expect((await get('ana', live.id)).stakeInfo).toBeNull();
    const none = await playOut({}, { ana: 1000, ben: 2000 });
    expect((await get('ana', none.id)).stakeInfo).toBeNull();
    await call('ana', 'POST', `/api/challenges/${none.id}/stake/settle`, {}, 400);
  });
});

describe('rematch', () => {
  it('carries the stake over unsettled, names rounds tidily and keeps a series record', async () => {
    // Round 1: Ana wins.
    const r1 = await playOut({ stake: COFFEE }, { ana: 5000, ben: 3000 });
    await call('ana', 'POST', `/api/challenges/${r1.id}/stake/settle`, {});
    expect((await get('ana', r1.id)).rematchSeries).toBeNull();

    // Round 2 starts tomorrow (day 7). Ben wins it.
    const r2 = await call<ChallengeDetail>(
      'ana',
      'POST',
      `/api/challenges/${r1.id}/rematch`,
      {},
      201,
    );
    expect(r2.name).toBe('Rematch: Step Duel');
    expect(r2.stake).toBe(COFFEE);
    expect(r2.rematchOf).toBe(r1.id);
    expect(r2.stakeInfo).toBeNull();
    const [row2] = await ctx.db.select().from(challenges).where(eq(challenges.id, r2.id));
    expect(row2!.stakeSettledAt).toBeNull();
    await call('ben', 'POST', `/api/challenges/${r2.id}/respond`, { accept: true });
    // Nothing has finished in the chain beyond round 1, and a lone finished round still counts.
    const early = await get('ana', r2.id);
    expect(early.rematchSeries).toMatchObject({ rounds: 1, position: 2, total: 2 });
    await setClock(`${day(8)}T12:00:00Z`);
    await setData(day(8), { ana: 2000, ben: 4000 });
    await setClock(`${day(14)}T12:00:00Z`);
    await finalize(r2.id);

    // Round 3 is named "(round 3)", never "Rematch: Rematch:".
    const r3 = await call<ChallengeDetail>(
      'ben',
      'POST',
      `/api/challenges/${r2.id}/rematch`,
      {},
      201,
    );
    expect(r3.name).toBe('Step Duel (round 3)');
    await call('ana', 'POST', `/api/challenges/${r3.id}/respond`, { accept: true });

    // Series: Ana 1 - Ben 1 so far, from any challenge in the chain.
    for (const id of [r1.id, r2.id, r3.id]) {
      const s = (await get('ana', id)).rematchSeries!;
      expect(s).toMatchObject({ rounds: 2, total: 3 });
      expect(s.entries.map((e) => [e.user.id, e.wins, e.isMe]).sort()).toEqual(
        [
          [ids.ana, 1, true],
          [ids.ben, 1, false],
        ].sort(),
      );
    }
    expect((await get('ben', r1.id)).rematchSeries!.entries.find((e) => e.isMe)!.user.id).toBe(
      ids.ben,
    );
    expect((await get('ana', r3.id)).rematchSeries!.position).toBe(3);

    // Round 3: Ana wins, so she leads 2 - 1.
    await setClock(`${day(16)}T12:00:00Z`);
    await setData(day(16), { ana: 9000, ben: 100 });
    await setClock(`${day(22)}T12:00:00Z`);
    await finalize(r3.id);
    const s = (await get('ana', r3.id)).rematchSeries!;
    expect(s.rounds).toBe(3);
    expect(s.entries[0]).toMatchObject({ wins: 2, isMe: true });
    expect(s.entries[1]).toMatchObject({ wins: 1, isMe: false });
    // The stake still rides along, and the loser (Ben) owes it again.
    expect((await get('ana', r3.id)).stakeInfo!.owedBy.map((u) => u.id)).toEqual([ids.ben]);
    expect((await get('ana', r3.id)).stakeInfo!.settledAt).toBeNull();
  });

  it('does not stack the Rematch prefix on older names and shortens long ones', async () => {
    const long = 'L'.repeat(60);
    const c = await playOut({ name: `Rematch: ${long.slice(0, 51)}` }, { ana: 2, ben: 1 });
    const r = await call<ChallengeDetail>(
      'ana',
      'POST',
      `/api/challenges/${c.id}/rematch`,
      {},
      201,
    );
    expect(r.name).toMatch(/ \(round 3\)$/);
    expect(r.name).not.toContain('Rematch');
    expect(r.name.length).toBeLessThanOrEqual(60);
  });
});
