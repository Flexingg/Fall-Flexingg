import type { ChallengeDetail, MeUser } from '@gauntlet/shared';
import { SparkyClient } from '@gauntlet/sparky';
import { FakeSparky, type FakeUser } from '@gauntlet/sparky/testing';
import { eq, sql } from 'drizzle-orm';
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

const create = (body: object, expect = 201) =>
  call<ChallengeDetail>('ana', 'POST', '/api/challenges', { ...base, ...body }, expect);
const teamId = (c: ChallengeDetail, name: string) => c.teams!.find((t) => t.name === name)!.id;
/** Everyone's data for the day, read the way the real app reads it: through a sync. */
async function setData(data: Partial<Record<Who, { steps?: number; rhr?: number }>>) {
  for (const who of people) {
    const d = data[who];
    sparkyOf[who].daily.length = 0;
    if (d)
      sparkyOf[who].daily.push({
        entry_date: day(0),
        ...(d.steps != null ? { total_steps: d.steps } : {}),
        ...(d.rhr != null ? { resting_heart_rate: d.rhr } : {}),
      });
    await syncUser(ctx, ids[who]);
  }
}

describe('creating a team challenge', () => {
  it('validates the teams', async () => {
    const bad = async (teams: object) => create({ teams }, 400);
    await bad({ teams: [RED] });
    await bad({ teams: [RED, { ...BLUE, name: 'red rockets' }] });
    await bad({ teams: [RED, { ...BLUE, color: RED.color }] });
    await bad({ teams: [RED, { ...BLUE, color: '#123456' }] });
    await bad({ teams: [RED, { ...BLUE, name: 'x'.repeat(25) }] });
    await bad({ teams: [RED, { ...BLUE, name: '  ' }] });
    await bad({
      teams: Array.from({ length: 7 }, (_, i) => ({
        name: `T${i}`,
        color: ['#ff6b6b', '#ffb347', '#5fe08a', '#4dd0e1', '#7a9cff', '#e07aff', '#000000'][i],
      })),
    });
    await create({ teams: { teams: [RED, BLUE] }, solo: { kind: 'target' }, goal: 1000 }, 400);
  });

  it('defaults to team average, puts the creator on a team and lists teams', async () => {
    const c = await create({ teams: { teams: [RED, BLUE], myTeam: 1 }, inviteUserIds: [ids.ben] });
    expect(c.teamScoring).toBe('avg');
    expect(c.teams!.map((t) => t.name).sort()).toEqual(['Blue Blazers', 'Red Rockets']);
    expect(c.myTeamId).toBe(teamId(c, 'Blue Blazers'));
    expect(c.teams!.find((t) => t.name === 'Blue Blazers')!.memberIds).toEqual([ids.ana]);
    expect(c.standings[0]).toMatchObject({ teamId: teamId(c, 'Blue Blazers') });
  });
});

describe('joining and moving', () => {
  let c: ChallengeDetail;
  it('needs a valid team to join, and allows switching until the start', async () => {
    await setClock('2026-10-05T12:00:00Z');
    c = await create({
      startDate: day(2),
      endDate: day(8),
      teams: { teams: [RED, BLUE] },
      inviteUserIds: [ids.ben, ids.cat, ids.dan],
    });
    const red = teamId(c, 'Red Rockets');
    const blue = teamId(c, 'Blue Blazers');
    const respond = (who: Who, body: object, expect = 200) =>
      call(who, 'POST', `/api/challenges/${c.id}/respond`, body, expect);
    await respond('ben', { accept: true }, 400);
    await respond('ben', { accept: true, teamId: '00000000-0000-4000-8000-000000000000' }, 400);
    await respond('ben', { accept: true, teamId: red });
    await respond('cat', { accept: true, teamId: blue });
    // Switching before the start is fine.
    const switched = (await respond('ben', { accept: true, teamId: blue })) as ChallengeDetail;
    expect(switched.myTeamId).toBe(blue);
    expect(switched.teams!.find((t) => t.id === blue)!.memberIds).toContain(ids.ben);
    expect(switched.teams!.find((t) => t.id === red)!.memberIds).toEqual([ids.ana]);
    // Declining has no team to pick.
    await respond('dan', { accept: false });
  });

  it('lets only the creator move people, until the start', async () => {
    const red = teamId(c, 'Red Rockets');
    const url = (t: string) => `/api/challenges/${c.id}/teams/${t}/members`;
    await call('ben', 'PATCH', url(red), { userIds: [ids.ben] }, 403);
    await call('ben', 'POST', `/api/challenges/${c.id}/teams/shuffle`, {}, 403);
    // Dan declined, so he can't be moved.
    await call('ana', 'PATCH', url(red), { userIds: [ids.dan] }, 400);
    const moved = await call<ChallengeDetail>('ana', 'PATCH', url(red), {
      userIds: [ids.ben, ids.cat],
    });
    expect(moved.teams!.find((t) => t.id === red)!.memberIds.sort()).toEqual(
      [ids.ana, ids.ben, ids.cat].sort(),
    );
    const shuffled = await call<ChallengeDetail>(
      'ana',
      'POST',
      `/api/challenges/${c.id}/teams/shuffle`,
      {},
    );
    const sizes = shuffled.teams!.map((t) => t.memberIds.length);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(3);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it('locks everything once the challenge starts, but newcomers can still pick', async () => {
    await call('ana', 'POST', `/api/challenges/${c.id}/invite`, { userIds: [ids.eve] });
    await setClock(`${day(2)}T12:00:00Z`);
    const blue = teamId(c, 'Blue Blazers');
    const red = teamId(c, 'Red Rockets');
    const mine = (await call<ChallengeDetail>('ben', 'GET', `/api/challenges/${c.id}`)).myTeamId;
    const other = mine === blue ? red : blue;
    const res = await raw('ben', 'POST', `/api/challenges/${c.id}/respond`, {
      accept: true,
      teamId: other,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'teams_locked' });
    await call(
      'ana',
      'PATCH',
      `/api/challenges/${c.id}/teams/${other}/members`,
      {
        userIds: [ids.ben],
      },
      400,
    );
    await call('ana', 'POST', `/api/challenges/${c.id}/teams/shuffle`, {}, 400);
    // Eve was invited and hasn't picked yet: she can after the start.
    const joined = await call<ChallengeDetail>('eve', 'POST', `/api/challenges/${c.id}/respond`, {
      accept: true,
      teamId: other,
    });
    expect(joined.myTeamId).toBe(other);
    await setClock('2026-10-05T12:00:00Z');
  });
});

describe('team scores and the end of a challenge', () => {
  /** Red: ana 12k + ben 8k. Blue: cat, dan, eve 9k each. Total: blue 27k wins; average: red 10k wins. */
  async function play(mode: 'sum' | 'avg') {
    const c = await create({
      name: `Steps ${mode}`,
      teams: { scoring: mode, teams: [RED, BLUE] },
      inviteUserIds: [ids.ben, ids.cat, ids.dan, ids.eve],
    });
    const red = teamId(c, 'Red Rockets');
    const blue = teamId(c, 'Blue Blazers');
    for (const [who, team] of [
      ['ben', red],
      ['cat', blue],
      ['dan', blue],
      ['eve', blue],
    ] as const)
      await call(who, 'POST', `/api/challenges/${c.id}/respond`, { accept: true, teamId: team });
    return { id: c.id, red, blue };
  }
  const scoresIn = () =>
    setData({
      ana: { steps: 12_000 },
      ben: { steps: 8_000 },
      cat: { steps: 9_000 },
      dan: { steps: 9_000 },
      eve: { steps: 9_000 },
    });

  it('team total adds scores; team average ignores team size', async () => {
    const sum = await play('sum');
    const avg = await play('avg');
    await scoresIn();
    const s = await call<ChallengeDetail>('ana', 'GET', `/api/challenges/${sum.id}`);
    expect(s.teams!.map((t) => [t.name, t.score, t.rank])).toEqual([
      ['Blue Blazers', 27_000, 1],
      ['Red Rockets', 20_000, 2],
    ]);
    const a = await call<ChallengeDetail>('ana', 'GET', `/api/challenges/${avg.id}`);
    expect(a.teams!.map((t) => [t.name, t.score, t.rank])).toEqual([
      ['Red Rockets', 10_000, 1],
      ['Blue Blazers', 9_000, 2],
    ]);
    // Individuals still use the normal scoring and carry their team; your place is your team's.
    expect(a.standings.find((r) => r.isMe)).toMatchObject({ score: 12_000, rank: 1 });
    expect(a.standings.find((r) => r.user.id === ids.eve)).toMatchObject({
      teamId: avg.blue,
    });
    const eveView = await call<ChallengeDetail>('eve', 'GET', `/api/challenges/${avg.id}`);
    expect(eveView.myRank).toBe(2);
    expect(eveView.myScore).toBe(9_000);
  });

  it('ranks teams low-to-high for lower-is-better stats and skips members with no score', async () => {
    const c = await create({
      name: 'Calm hearts',
      metric: 'resting_hr',
      scoring: 'total',
      teams: { teams: [RED, BLUE] },
      inviteUserIds: [ids.ben, ids.cat],
    });
    const red = teamId(c, 'Red Rockets');
    const blue = teamId(c, 'Blue Blazers');
    await call('ben', 'POST', `/api/challenges/${c.id}/respond`, { accept: true, teamId: red });
    await call('cat', 'POST', `/api/challenges/${c.id}/respond`, { accept: true, teamId: blue });
    // Red: ana 60 and ben has no reading. Blue: cat 55. Lower wins, and Ben isn't counted as zero.
    await setData({ ana: { rhr: 60 }, cat: { rhr: 55 } });
    const d = await call<ChallengeDetail>('ana', 'GET', `/api/challenges/${c.id}`);
    expect(d.teams!.map((t) => [t.name, t.score, t.rank])).toEqual([
      ['Blue Blazers', 55, 1],
      ['Red Rockets', 60, 2],
    ]);
  });

  it('finalizing gives members their team rank and own score, announces the winners', async () => {
    const g = await play('avg');
    await scoresIn();
    await setClock(`${day(6)}T12:00:00Z`);
    const [row] = await ctx.db.select().from(challenges).where(eq(challenges.id, g.id));
    expect(await finalizeChallenge(ctx, row!)).toBe(true);
    // Never twice.
    expect(await finalizeChallenge(ctx, row!)).toBe(false);

    const parts = await ctx.db
      .select()
      .from(challengeParticipants)
      .where(eq(challengeParticipants.challengeId, g.id));
    const rankOf = (who: Who) => parts.find((p) => p.userId === ids[who])!;
    expect(rankOf('ana')).toMatchObject({ finalRank: 1, finalScore: 12_000 });
    expect(rankOf('ben')).toMatchObject({ finalRank: 1, finalScore: 8_000 });
    expect(rankOf('cat')).toMatchObject({ finalRank: 2, finalScore: 9_000 });
    expect(rankOf('eve')).toMatchObject({ finalRank: 2 });

    const won = await ctx.db.select().from(feedEvents).where(eq(feedEvents.challengeId, g.id));
    const wins = won.filter((e) => e.kind === 'challenge_won');
    expect(wins.map((e) => e.actorId).sort()).toEqual([ids.ana, ids.ben].sort());
    expect(wins[0]!.payload).toMatchObject({ teamName: 'Red Rockets' });

    const notes = await ctx.db
      .select()
      .from(notifications)
      .where(eq(notifications.kind, 'challenge_finished'));
    const mine = notes.filter((n) => (n.payload as { challengeId?: string }).challengeId === g.id);
    expect(mine.map((n) => n.userId).sort()).toEqual(Object.values(ids).sort());
    expect(mine.find((n) => n.userId === ids.ana)!.body).toContain('Red Rockets won');

    // The page and result show the frozen team ranking.
    const d = await call<ChallengeDetail>('cat', 'GET', `/api/challenges/${g.id}`);
    expect(d.status).toBe('completed');
    expect(d.myRank).toBe(2);
    expect(d.teams![0]).toMatchObject({ name: 'Red Rockets', rank: 1 });
    const result = await call<{ me: { rank: number } }>(
      'cat',
      'GET',
      `/api/challenges/${g.id}/result`,
    );
    expect(result.me.rank).toBe(2);
    await setClock('2026-10-05T12:00:00Z');
  });
});
