import type { ChallengeDetail, FeedEvent } from '@gauntlet/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { challenges } from '../src/db/schema.js';
import { runSyncCycle } from '../src/scheduler.js';
import { syncUser } from '../src/services/sync.js';
import { SparkyClient } from '@gauntlet/sparky';
import { FakeSparky } from '@gauntlet/sparky/testing';

/**
 * Several people sync at once and their data arrives in an unlucky order. Whoever is
 * really ahead must end up as the recorded leader, and a later overtake must be
 * announced exactly once. This failed intermittently on CI before refreshChallenge
 * re-read the challenge under a lock.
 */
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/gauntlet_test';
const fake = new FakeSparky();
const clock = new Date('2026-10-02T18:00:00Z');
let app: FastifyInstance;
let ctx: AppContext;
let closeDb: () => Promise<void>;
const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};

const names = ['ann', 'ben', 'cat', 'dan'] as const;
const sparkyUsers = Object.fromEntries(
  names.map((n) => [
    n,
    fake.addUser({ id: `u-${n}`, email: `${n}@example.com`, password: 'pw', name: n }),
  ]),
);

async function call<T>(who: string, method: string, url: string, payload?: unknown): Promise<T> {
  const res = await app.inject({
    method: method as 'GET',
    url,
    payload: payload as object,
    headers: { 'x-gauntlet-client': 'native', authorization: `Bearer ${tokens[who]}` },
  });
  if (res.statusCode >= 400) throw new Error(`${method} ${url} -> ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}

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
    ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  });
  ({ app, ctx } = await buildApp({
    db,
    cfg,
    sparky: new SparkyClient({ baseUrl: fake.baseUrl, fetch: fake.fetch }),
    now: () => clock,
  }));
  closeDb = () => client.end();

  for (const n of names) {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { method: 'api_key', apiKey: fake.mintKey(`u-${n}`) },
      headers: { 'x-gauntlet-client': 'native' },
    });
    const body = r.json() as { accessToken: string; user: { id: string } };
    tokens[n] = body.accessToken;
    ids[n] = body.user.id;
  }
  // ann befriends everyone through an invite link, then starts a challenge with all of them.
  const inv = await call<{ code: string }>('ann', 'POST', '/api/invites', { kind: 'friend' });
  for (const n of names.slice(1)) await call(n, 'POST', `/api/invites/${inv.code}/accept`);
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

const day = (n: string, km: number) => {
  const u = sparkyUsers[n]!;
  u.daily = [
    { entry_date: '2026-10-02', source_provider: 'garmin', total_distance_meters: km * 1000 },
  ];
};
const leaderId = async (id: string) =>
  (await ctx.db.select().from(challenges).where(eq(challenges.id, id)))[0]!.leaderId;
const tookLead = async (who: string) =>
  (await call<FeedEvent[]>(who, 'GET', '/api/feed')).filter((e) => e.kind === 'took_lead');

describe('leader tracking under concurrent syncs', () => {
  let challengeId = '';

  it('records the real leader even when a runner-up finishes syncing first', async () => {
    const created = await call<ChallengeDetail>('ann', 'POST', '/api/challenges', {
      name: 'Race',
      metric: 'distance',
      scoring: 'total',
      startDate: '2026-10-02',
      endDate: '2026-10-04',
      timezone: 'UTC',
      inviteUserIds: names.slice(1).map((n) => ids[n]),
    });
    challengeId = created.id;
    for (const n of names.slice(1))
      await call(n, 'POST', `/api/challenges/${challengeId}/respond`, { accept: true });

    // Logging in, creating and accepting each start a background sync. Let them all finish so
    // the only syncing that happens from here on is the cycle under test.
    await Promise.all(names.map((n) => syncUser(ctx, ids[n]!)));

    day('ann', 30);
    day('ben', 12);
    day('cat', 20);
    day('dan', 8);
    // ann is far ahead but her data arrives last; everyone else is done well before.
    fake.latencyMs = { 'u-ann': 250, 'u-ben': 0, 'u-cat': 40, 'u-dan': 80 };

    const cycle = await runSyncCycle(ctx);
    expect(cycle.synced).toBe(4);
    expect(await leaderId(challengeId)).toBe(ids.ann);
    // The first-ever leader is not an "overtake".
    expect(await tookLead('ben')).toHaveLength(0);
  });

  it('announces an overtake exactly once', async () => {
    day('ben', 45); // ben jumps ahead of ann
    fake.latencyMs = { 'u-ann': 0, 'u-ben': 120, 'u-cat': 0, 'u-dan': 30 };
    await runSyncCycle(ctx);
    expect(await leaderId(challengeId)).toBe(ids.ben);
    const events = await tookLead('cat');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ text: 'ben took the lead in Race' });

    // Re-syncing with no change must not repeat it.
    await runSyncCycle(ctx);
    expect(await tookLead('cat')).toHaveLength(1);
  });
});
