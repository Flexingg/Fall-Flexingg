import type { ChallengeDetail, DiscoverResponse, MeUser, UserCard } from '@gauntlet/shared';
import { SparkyClient } from '@gauntlet/sparky';
import { FakeSparky } from '@gauntlet/sparky/testing';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, runMigrations } from '../src/db/index.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/gauntlet_test';
const fake = new FakeSparky();
let app: FastifyInstance;
let closeDb: () => Promise<void>;
const people = {
  ana: { email: 'ana@example.com', name: 'Ana Lima' },
  ben: { email: 'ben@example.com', name: 'Ben Ortiz' },
  cat: { email: 'cat@example.com', name: 'Cat Anderson' },
  admin: { email: 'boss@example.com', name: 'Server Boss' },
};
type Who = keyof typeof people;
const access: Partial<Record<Who, string>> = {};
const ids: Partial<Record<Who, string>> = {};

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
    ADMIN_EMAILS: 'Boss@Example.com',
  });
  ({ app } = await buildApp({
    db,
    cfg,
    sparky: new SparkyClient({ baseUrl: fake.baseUrl, fetch: fake.fetch }),
    now: () => new Date(),
  }));
  closeDb = () => client.end();
  for (const [who, p] of Object.entries(people) as [Who, (typeof people)[Who]][]) {
    fake.addUser({ id: `u-${who}`, email: p.email, password: `pw-${who}`, name: p.name });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { method: 'password', email: p.email, password: `pw-${who}` },
      headers: { 'x-gauntlet-client': 'native' },
    });
    const body = res.json() as { accessToken: string; user: MeUser };
    access[who] = body.accessToken;
    ids[who] = body.user.id;
  }
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

async function call<T = unknown>(
  who: Who,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: object,
  expect = 200,
): Promise<T> {
  const res = await app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${access[who]}` },
  });
  if (res.statusCode !== expect)
    throw new Error(`${method} ${url} -> ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}

const today = new Date().toISOString().slice(0, 10);
const newChallenge = (visibility: 'public' | 'private') => ({
  name: `${visibility} steps`,
  metric: 'steps',
  scoring: 'total',
  startDate: today,
  endDate: today,
  timezone: 'UTC',
  visibility,
});

describe('profiles are private by default', () => {
  it('starts private, and private people never show up in search', async () => {
    const me = await call<MeUser>('ana', 'GET', '/api/me');
    expect(me.visibility).toBe('private');
    expect(me.handle).toBeNull();
    expect(me.isAdmin).toBe(false);
    expect(await call<UserCard[]>('ben', 'GET', '/api/users/search?q=ana')).toEqual([]);
    // Nor can a stranger look them up or befriend them by id.
    await call('ben', 'GET', `/api/users/${ids.ana}`, undefined, 404);
    await call('ben', 'POST', '/api/friends/requests', { userId: ids.ana }, 404);
  });

  it('going public makes you findable by name or handle, without your email', async () => {
    await call('ana', 'PATCH', '/api/me', { visibility: 'public', handle: '@Ana_L' });
    const me = await call<MeUser>('ana', 'GET', '/api/me');
    expect(me).toMatchObject({ visibility: 'public', handle: 'ana_l' });

    const byName = await call<UserCard[]>('ben', 'GET', '/api/users/search?q=lim');
    expect(byName.map((u) => u.displayName)).toEqual(['Ana Lima']);
    expect(byName[0]).toEqual({
      id: ids.ana,
      displayName: 'Ana Lima',
      initials: 'AL',
      handle: 'ana_l',
      challenges: { played: 0, won: 0 },
      friendship: 'none',
    });
    expect(JSON.stringify(byName)).not.toContain('@example.com');
    const byHandle = await call<UserCard[]>('ben', 'GET', '/api/users/search?q=@ana_');
    expect(byHandle.map((u) => u.id)).toEqual([ids.ana]);
    // Wildcards are taken literally.
    expect(await call<UserCard[]>('ben', 'GET', '/api/users/search?q=%25%25')).toEqual([]);
  });

  it('handles are unique and validated', async () => {
    await call('ben', 'PATCH', '/api/me', { handle: 'ana_l' }, 409);
    await call('ben', 'PATCH', '/api/me', { handle: 'no spaces' }, 400);
    await call('ben', 'PATCH', '/api/me', { handle: 'ben' });
    await call('ben', 'PATCH', '/api/me', { handle: '' });
    expect((await call<MeUser>('ben', 'GET', '/api/me')).handle).toBeNull();
  });

  it('anyone can send a public person a friend request by id', async () => {
    expect(await call('ben', 'POST', '/api/friends/requests', { userId: ids.ana })).toEqual({
      status: 'requested',
    });
    const card = await call<UserCard>('ben', 'GET', `/api/users/${ids.ana}`);
    expect(card.friendship).toBe('outgoing');
    expect((await call<UserCard>('ana', 'GET', `/api/users/${ids.ben}`)).friendship).toBe(
      'incoming',
    );
  });

  it('going private again removes you from search at once', async () => {
    await call('ana', 'PATCH', '/api/me', { visibility: 'private' });
    expect(await call<UserCard[]>('cat', 'GET', '/api/users/search?q=ana')).toEqual([]);
    // Ben has a pending request with Ana, so he can still see her.
    await call('ben', 'GET', `/api/users/${ids.ana}`);
    await call('cat', 'GET', `/api/users/${ids.ana}`, undefined, 404);
    await call('ana', 'PATCH', '/api/me', { visibility: 'public' });
  });
});

describe('public challenges', () => {
  let pub: ChallengeDetail;
  let priv: ChallengeDetail;

  it('needs a public profile to start one', async () => {
    await call('cat', 'POST', '/api/challenges', newChallenge('public'), 400);
    pub = await call<ChallengeDetail>(
      'ana',
      'POST',
      '/api/challenges',
      newChallenge('public'),
      201,
    );
    expect(pub).toMatchObject({ visibility: 'public', featured: false });
    priv = await call<ChallengeDetail>(
      'ana',
      'POST',
      '/api/challenges',
      newChallenge('private'),
      201,
    );
  });

  it('lists public challenges in Discover; private ones stay hidden', async () => {
    const d = await call<DiscoverResponse>('cat', 'GET', '/api/challenges/discover');
    expect(d.canJoin).toBe(false);
    expect(d.challenges.map((c) => c.id)).toEqual([pub.id]);
    expect(d.challenges[0]!.myState).toBeNull();
    // Strangers can look at a public challenge, not a private one.
    const seen = await call<ChallengeDetail>('cat', 'GET', `/api/challenges/${pub.id}`);
    expect(seen.standings.map((s) => s.user.displayName)).toEqual(['Ana Lima']);
    expect(JSON.stringify(seen)).not.toContain('@example.com');
    await call('cat', 'GET', `/api/challenges/${priv.id}`, undefined, 403);
    await call('cat', 'POST', `/api/challenges/${priv.id}/join`, undefined, 404);
  });

  it('private people can look but must go public to join', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/challenges/${pub.id}/join`,
      headers: { authorization: `Bearer ${access.cat}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'needs_public' });

    await call('cat', 'PATCH', '/api/me', { visibility: 'public' });
    const joined = await call<ChallengeDetail>('cat', 'POST', `/api/challenges/${pub.id}/join`);
    expect(joined.myState).toBe('joined');
    expect(joined.participantCount).toBe(2);
    // Joining twice is fine.
    await call('cat', 'POST', `/api/challenges/${pub.id}/join`);
    // Challenge-mates can see each other even after going private.
    await call('cat', 'PATCH', '/api/me', { visibility: 'private' });
    await call('ana', 'GET', `/api/users/${ids.cat}`);
    const list = await call<{ id: string }[]>('cat', 'GET', '/api/challenges');
    expect(list.map((c) => c.id)).toContain(pub.id);
  });

  it('only server admins can feature a challenge, and featured ones come first', async () => {
    await call('ana', 'PATCH', `/api/challenges/${pub.id}/featured`, { featured: true }, 403);
    expect((await call<MeUser>('admin', 'GET', '/api/me')).isAdmin).toBe(true);
    await call('admin', 'PATCH', '/api/me', { visibility: 'public' });
    const second = await call<ChallengeDetail>(
      'admin',
      'POST',
      '/api/challenges',
      { ...newChallenge('public'), name: 'Featured one' },
      201,
    );
    await call('admin', 'PATCH', `/api/challenges/${priv.id}/featured`, { featured: true }, 400);
    const f = await call<ChallengeDetail>(
      'admin',
      'PATCH',
      `/api/challenges/${second.id}/featured`,
      {
        featured: true,
      },
    );
    expect(f.featured).toBe(true);
    const d = await call<DiscoverResponse>('ben', 'GET', '/api/challenges/discover');
    expect(d.challenges.map((c) => c.name)).toEqual(['Featured one', 'public steps']);
  });
});
