import type {
  ChallengeProgress,
  ChallengeSummary,
  FriendsResponse,
  MeUser,
} from '@gauntlet/shared';
import { SparkyClient } from '@gauntlet/sparky';
import { FakeSparky } from '@gauntlet/sparky/testing';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { refreshDemo } from '../src/services/demo.js';
import { dailyMetrics } from '../src/db/schema.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/gauntlet_test';
const fake = new FakeSparky();
let app: FastifyInstance;
let ctx: AppContext;
let closeDb: () => Promise<void>;
let access = '';
const clock = new Date('2026-10-05T18:00:00Z');

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
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

async function call<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    payload: payload as object | undefined,
    headers: { authorization: `Bearer ${access}`, 'x-gauntlet-client': 'native' },
  });
  return { status: res.statusCode, body: res.json() as T };
}

describe('demo account', () => {
  it('signs in without SparkyFitness and builds the cast on first use', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/demo',
      headers: { 'x-gauntlet-client': 'native' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { accessToken: string; user: MeUser };
    expect(body.user.demo).toBe(true);
    expect(body.user.visibility).toBe('private');
    access = body.accessToken;
  });

  it('has friends and challenges around today with real standings', async () => {
    const friends = await call<FriendsResponse>('GET', '/api/friends');
    expect(friends.body.friends.length).toBe(5);
    const list = await call<ChallengeSummary[]>('GET', '/api/challenges');
    const names = list.body.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['Steps this week', 'Run 80 km', 'Beat my last 30 days']),
    );
    const steps = list.body.find((c) => c.name === 'Steps this week')!;
    const prog = await call<ChallengeProgress>('GET', `/api/challenges/${steps.id}/progress`);
    expect(prog.status).toBe(200);
    expect(prog.body.series.length).toBeGreaterThan(2);
    const old = list.body.find((c) => c.name === 'Last week: most steps')!;
    expect(old.status).toBe('completed');
  });

  it('keeps solo challenges working', async () => {
    const list = await call<ChallengeSummary[]>('GET', '/api/challenges');
    const solo = list.body.find((c) => c.name === 'Run 80 km')!;
    expect(solo.solo).toBeTruthy();
    expect(solo.myScore).not.toBeNull();
  });

  it('switches off what needs a real SparkyFitness or other people', async () => {
    expect((await call('DELETE', '/api/me')).status).toBe(403);
    expect((await call('PATCH', '/api/me', { visibility: 'public' })).status).toBe(403);
    expect((await call('POST', '/api/friends/requests', { handle: 'x' })).status).toBe(403);
    expect((await call('POST', '/api/invites', { kind: 'friend' })).status).toBe(403);
    expect((await call('GET', '/api/connections')).status).toBe(403);
    expect((await call('POST', '/api/me/fast/start', { hours: 16 })).status).toBe(403);
    expect((await call('GET', '/api/sources')).status).toBe(200);
    expect((await call<unknown[]>('GET', '/api/me/lifts')).body).toEqual([]);
    expect((await call('GET', '/api/me')).status).toBe(200);
  });

  it('rebuilds cleanly without duplicating anything', async () => {
    await refreshDemo(ctx);
    await refreshDemo(ctx);
    const list = await call<ChallengeSummary[]>('GET', '/api/challenges');
    expect(list.body.filter((c) => c.name === 'Steps this week').length).toBe(1);
    const [row] = await ctx.db.execute<{ n: number }>(
      sql`select count(*)::int as n from ${dailyMetrics} where metric = 'steps'`,
    );
    expect(row?.n).toBe(6 * 71);
  });

  it('can be switched off', async () => {
    const off = await buildApp({
      db: ctx.db,
      cfg: loadConfig({
        DATABASE_URL: DB_URL,
        JWT_SECRET: 'test-secret-test-secret-test-secret-123',
        ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        DEMO_ACCOUNT: 'false',
      }),
      sparky: ctx.sparky,
      now: () => clock,
    });
    const res = await off.app.inject({ method: 'POST', url: '/api/auth/demo' });
    expect(res.statusCode).toBe(404);
    await off.app.close();
  });
});
