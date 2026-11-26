import type { MeUser, ProfileResponse } from '@gauntlet/shared';
import { SparkyClient } from '@gauntlet/sparky';
import { FakeSparky } from '@gauntlet/sparky/testing';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, runMigrations, type Db } from '../src/db/index.js';
import { challengeParticipants, challenges, dailyMetrics } from '../src/db/schema.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/gauntlet_test';
const fake = new FakeSparky();
let app: FastifyInstance;
let db: Db;
let closeDb: () => Promise<void>;
const people = {
  ana: { email: 'ana@example.com', name: 'Ana Lima' },
  ben: { email: 'ben@example.com', name: 'Ben Ortiz' },
  cat: { email: 'cat@example.com', name: 'Cat Anderson' },
  dan: { email: 'dan@example.com', name: 'Dan Reyes' },
  eve: { email: 'eve@example.com', name: 'Eve Stone' },
};
type Who = keyof typeof people;
const access: Partial<Record<Who, string>> = {};
const ids = {} as Record<Who, string>;

async function call<T = unknown>(
  who: Who,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

/** A finished challenge with final ranks (score null = joined but never scored). */
async function finished(opts: {
  name: string;
  visibility?: 'private' | 'public';
  solo?: boolean;
  ranks: [Who, number, number | null][];
}) {
  const [ch] = await db
    .insert(challenges)
    .values({
      name: opts.name,
      metric: 'steps',
      aggregate: 'sum',
      scoring: 'total',
      startDate: '2026-10-01',
      endDate: '2026-10-07',
      timezone: 'UTC',
      createdBy: ids[opts.ranks[0]![0]],
      visibility: opts.visibility ?? 'private',
      solo: opts.solo ? ({ kind: 'total', target: 1 } as never) : null,
      finalizedAt: new Date('2026-10-08T00:00:00Z'),
    })
    .returning();
  await db.insert(challengeParticipants).values(
    opts.ranks.map(([who, rank, score]) => ({
      challengeId: ch!.id,
      userId: ids[who],
      state: 'joined' as const,
      finalRank: rank,
      finalScore: score,
    })),
  );
  return ch!.id;
}

let duel = '';
beforeAll(async () => {
  const created = createDb(DB_URL);
  db = created.db;
  await db.execute(
    sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`,
  );
  await runMigrations(db);
  ({ app } = await buildApp({
    db,
    cfg: loadConfig({
      DATABASE_URL: DB_URL,
      SPARKY_URL: fake.baseUrl,
      PUBLIC_WEB_URL: 'https://gauntlet.test',
      JWT_SECRET: 'test-secret-test-secret-test-secret-123',
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      SYNC_INTERVAL_MINUTES: '0',
    }),
    sparky: new SparkyClient({ baseUrl: fake.baseUrl, fetch: fake.fetch }),
    now: () => new Date(),
  }));
  closeDb = () => created.client.end();
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

  // Ana and Ben are friends. Eve has nothing to do with Ana.
  await call('ana', 'POST', '/api/friends/requests', { email: people.ben.email });
  await call('ben', 'POST', `/api/friends/requests/${ids.ana}/accept`);

  // Three 10k days in a row, then a short one; plus weight, which must never surface.
  const day = (d: number) => `2026-10-0${d}`;
  await db
    .insert(dailyMetrics)
    .values([
      ...[1, 2, 3].map((d) => ({ userId: ids.ana, date: day(d), metric: 'steps', value: 12_000 })),
      { userId: ids.ana, date: day(5), metric: 'steps', value: 5_000 },
      { userId: ids.ana, date: day(1), metric: 'distance', value: 9.25 },
      { userId: ids.ana, date: day(2), metric: 'distance', value: 4 },
      { userId: ids.ana, date: day(2), metric: 'workouts', value: 2 },
      { userId: ids.ana, date: day(3), metric: 'lift_volume', value: 4_000 },
      { userId: ids.ana, date: day(3), metric: 'weight', value: 81.5 },
    ]);

  duel = await finished({
    name: 'Ana vs Ben',
    ranks: [
      ['ana', 1, 500],
      ['ben', 2, 300],
    ],
  });
  await finished({
    name: 'Ana and Dan secret',
    ranks: [
      ['dan', 1, 900],
      ['ana', 2, 800],
    ],
  });
  await finished({
    name: 'Open sprint',
    visibility: 'public',
    ranks: [
      ['cat', 1, 9],
      ['dan', 2, 8],
      ['ana', 3, 7],
    ],
  });
  // Not trophies: a solo challenge, and a "win" where nobody else scored.
  await finished({ name: 'Me vs me', solo: true, ranks: [['ana', 1, 100]] });
  await finished({
    name: 'Walkover',
    ranks: [
      ['ana', 1, 50],
      ['dan', 2, null],
    ],
  });
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

const profile = (viewer: Who, of: Who, expect = 200) =>
  call<ProfileResponse>(viewer, 'GET', `/api/users/${ids[of]}/profile`, undefined, expect);

describe('profiles', () => {
  it('stays hidden from strangers', async () => {
    await profile('eve', 'ana', 404);
    await call('eve', 'GET', '/api/users/not-a-uuid/profile', undefined, 404);
  });

  it('shows friends the record and trophies, but not stats until shared', async () => {
    const p = await profile('ben', 'ana');
    expect(p.user).toMatchObject({ displayName: 'Ana Lima', friendship: 'friends' });
    expect(p.trophies).toMatchObject({ gold: 1, silver: 1, bronze: 1 });
    // Only podiums from real group challenges; private ones Ben wasn't in stay unnamed.
    expect(p.trophies.list.map((t) => [t.name, t.rank, t.field, !!t.challengeId])).toEqual(
      expect.arrayContaining([
        ['Ana vs Ben', 1, 2, true],
        ['Private challenge', 2, 2, false],
        ['Open sprint', 3, 3, true],
      ]),
    );
    expect(p.trophies.list).toHaveLength(3);
    expect(p.trophies.list.find((t) => t.challengeId === duel)?.metricLabel).toBe('Steps');
    expect(p.stats).toBeNull();
    expect(p.milestones).toBeNull();
    expect(p.shared).toBe(false);
  });

  it('always shows you your own stats and milestones, never weight', async () => {
    const p = await profile('ana', 'ana');
    expect(p.user.friendship).toBe('me');
    expect(p.trophies.list.map((t) => t.name)).toContain('Ana and Dan secret');
    expect(p.stats).toMatchObject({
      since: '2026-10-01',
      daysTracked: 4,
      totals: { steps: 41_000, distanceKm: 13.3, workouts: 2, liftVolumeKg: 4_000 },
      bests: { steps: 12_000, distanceKm: 9.3, stepStreakDays: 3, longestFastHours: null },
    });
    expect(JSON.stringify(p)).not.toMatch(/81\.5|weight/i);
    // Only the duel counts as a win: not the solo challenge or the walkover.
    expect(p.milestones!.filter((m) => m.achieved).map((m) => m.key)).toEqual(['wins:1']);
    // The next step up is offered with progress, not as reached.
    const next = p.milestones!.find((m) => m.key === 'steps:100000');
    expect(next).toMatchObject({ achieved: false, progress: 0.41 });
  });

  it('shares stats with people who can see you once you opt in', async () => {
    const me = await call<MeUser>('ana', 'PATCH', '/api/me', {
      settings: { shareProfileStats: true },
    });
    expect(me.settings.shareProfileStats).toBe(true);
    const p = await profile('ben', 'ana');
    expect(p.shared).toBe(true);
    expect(p.stats?.totals.steps).toBe(41_000);
    // Sharing stats doesn't make a private profile visible to strangers.
    await profile('eve', 'ana', 404);
  });

  it('public profiles are open to anyone signed in', async () => {
    await call('ana', 'PATCH', '/api/me', { visibility: 'public' });
    const p = await profile('eve', 'ana');
    expect(p.user.visibility).toBe('public');
    // Open sprint is a public challenge, so it's named; the private duel is not.
    expect(p.trophies.list.map((t) => t.name)).toEqual(
      expect.arrayContaining(['Open sprint', 'Private challenge']),
    );
    expect(p.trophies.list.map((t) => t.name)).not.toContain('Ana vs Ben');
    await call('ana', 'PATCH', '/api/me', { visibility: 'private' });
  });

  it('unfriending ends the friendship', async () => {
    await call('ben', 'DELETE', `/api/friends/${ids.ana}`);
    // They still shared a challenge, so Ben can see her, just not as a friend.
    expect((await profile('ben', 'ana')).user.friendship).toBe('none');
    const friends = await call<{ friends: { id: string }[] }>('ben', 'GET', '/api/friends');
    expect(friends.friends.map((f) => f.id)).not.toContain(ids.ana);
  });
});
