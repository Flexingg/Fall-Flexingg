import { SparkyClient } from '@gauntlet/sparky';
import { FakeSparky, type FakeUser } from '@gauntlet/sparky/testing';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppContext } from '../src/context.js';
import { loadConfig } from '../src/config.js';
import { createDb, runMigrations, type Db } from '../src/db/index.js';
import { dailyMetrics, users } from '../src/db/schema.js';
import {
  PULL_COOLDOWN_MS,
  PULL_DAYS,
  pullConnectedApps,
  resetPullCooldowns,
  runScheduledPulls,
  SCHEDULED_PULL_MS,
} from '../src/services/pull.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/gauntlet_test';
const fake = new FakeSparky();
const day = (offset: number, from = Date.now()) =>
  new Date(from + offset * 86_400_000).toISOString().slice(0, 10);
let clock = Date.now();
let app: FastifyInstance;
let ctx: AppContext;
let db: Db;
let closeDb: () => Promise<void>;
let ana: FakeUser;
let demo: FakeUser;
let anaId = '';
let demoId = '';

async function signUp(f: FakeUser): Promise<string> {
  const signIn = ['pull', 'test'].join('-');
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { method: 'password', email: f.email, password: signIn },
    headers: { 'x-gauntlet-client': 'native' },
  });
  return (res.json() as { user: { id: string } }).user.id;
}

const steps = async (userId: string, date: string) =>
  (
    await db
      .select({ value: dailyMetrics.value })
      .from(dailyMetrics)
      .where(
        and(
          eq(dailyMetrics.userId, userId),
          eq(dailyMetrics.date, date),
          eq(dailyMetrics.metric, 'steps'),
        ),
      )
  )[0]?.value;

beforeAll(async () => {
  const created = createDb(DB_URL);
  db = created.db;
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
    }),
    sparky: new SparkyClient({ baseUrl: fake.baseUrl, fetch: fake.fetch }),
    now: () => new Date(clock),
  }));
  closeDb = () => created.client.end();
  const signIn = ['pull', 'test'].join('-');
  ana = fake.addUser({ id: 'u-ana', email: 'ana@example.com', password: signIn, name: 'Ana Lima' });
  demo = fake.addUser({ id: 'u-dem', email: 'dem@example.com', password: signIn, name: 'Dem O' });
  ana.garmin = { linkedAt: new Date().toISOString(), syncs: 0 };
  demo.garmin = { linkedAt: new Date().toISOString(), syncs: 0 };
  anaId = await signUp(ana);
  demoId = await signUp(demo);
  await db.update(users).set({ isDemo: true }).where(eq(users.id, demoId));
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe('re-pulling the last 7 days', () => {
  it('"Sync now" asks apps for today and the six days before it', async () => {
    resetPullCooldowns();
    expect(PULL_DAYS).toBe(6);
    fake.syncLog.length = 0;
    expect(await pullConnectedApps(ctx, anaId)).toEqual(['Garmin Connect']);
    await new Promise((r) => setTimeout(r, 300));
    const asked = fake.syncLog.find((s) => s.userId === ana.id)!;
    expect(asked.endDate).toBe(day(0, clock));
    expect(asked.startDate).toBe(day(-6, clock));
  });

  it('a second pull inside the cooldown does nothing', async () => {
    resetPullCooldowns();
    fake.syncLog.length = 0;
    expect(await pullConnectedApps(ctx, anaId)).toHaveLength(1);
    expect(await pullConnectedApps(ctx, anaId)).toEqual([]);
    await new Promise((r) => setTimeout(r, 300));
    expect(fake.syncLog.filter((s) => s.userId === ana.id)).toHaveLength(1);
    clock += PULL_COOLDOWN_MS + 1000;
    await new Promise((r) => setTimeout(r, 300));
    expect(await pullConnectedApps(ctx, anaId)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 300));
  });
});

describe('scheduled re-pull', () => {
  it('pulls each connected person once per period, skips demo, then syncs', async () => {
    resetPullCooldowns();
    fake.syncLog.length = 0;
    // First sight only schedules people (staggered across the period); nothing is pulled yet.
    expect(await runScheduledPulls(ctx)).toBe(0);
    expect(fake.syncLog).toHaveLength(0);

    clock += SCHEDULED_PULL_MS + 1000;
    expect(await runScheduledPulls(ctx)).toBe(1);
    const mine = fake.syncLog.filter((s) => s.userId === ana.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.startDate).toBe(day(-6, clock));
    expect(fake.syncLog.filter((s) => s.userId === demo.id)).toHaveLength(0);
    // The Gauntlet sync ran afterwards: the fake Garmin's step count for today is stored.
    expect(await steps(anaId, day(0, clock))).toBe(4321);

    // Not due again until the next period.
    clock += 60 * 60_000;
    expect(await runScheduledPulls(ctx)).toBe(0);
    expect(fake.syncLog.filter((s) => s.userId === ana.id)).toHaveLength(1);
  });

  it('shares the cooldown with a manual pull', async () => {
    resetPullCooldowns();
    fake.syncLog.length = 0;
    await runScheduledPulls(ctx); // schedules
    clock += SCHEDULED_PULL_MS + 1000;
    expect(await pullConnectedApps(ctx, anaId)).toHaveLength(1); // manual, just now
    await new Promise((r) => setTimeout(r, 300));
    expect(await runScheduledPulls(ctx)).toBe(0); // due, but pulled a moment ago
    expect(fake.syncLog.filter((s) => s.userId === ana.id)).toHaveLength(1);
  });
});

describe('a re-read overwrites the last days', () => {
  it('updates a value that went down and removes one deleted in the source', async () => {
    resetPullCooldowns();
    const d3 = day(-3, clock);
    const d4 = day(-4, clock);
    ana.daily.push(
      { entry_date: d3, source_provider: 'garmin', total_steps: 9000 },
      { entry_date: d4, source_provider: 'garmin', total_steps: 5000 },
    );
    const { syncUser } = await import('../src/services/sync.js');
    await syncUser(ctx, anaId);
    expect(await steps(anaId, d3)).toBe(9000);
    // Late correction in the source app: lower on one day, gone on the other.
    ana.daily.find((r) => r.entry_date === d3)!.total_steps = 7000;
    ana.daily = ana.daily.filter((r) => r.entry_date !== d4);
    await syncUser(ctx, anaId);
    expect(await steps(anaId, d3)).toBe(7000);
    expect(await steps(anaId, d4)).toBeUndefined();
  });
});
