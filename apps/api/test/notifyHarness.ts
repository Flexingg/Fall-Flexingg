/**
 * Shared setup for the notification tests: a real app and Postgres, an in-memory SparkyFitness,
 * a few signed-in people and a clock the test can move.
 */
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SparkyClient } from '@gauntlet/sparky';
import { FakeSparky, type FakeUser } from '@gauntlet/sparky/testing';
import { signAccessToken } from '../src/auth.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { createDb, runMigrations } from '../src/db/index.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/gauntlet_test';

export interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  fake: FakeSparky;
  ids: Record<string, string>;
  tokens: Record<string, string>;
  sparky: Record<string, FakeUser>;
  /** Move the clock the app sees. */
  setClock: (iso: string) => void;
  call: <T>(who: string, method: string, url: string, payload?: unknown) => Promise<T>;
  /** Like call, but returns the raw response so tests can look at errors. */
  raw: (
    who: string | null,
    method: string,
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ) => Promise<{
    statusCode: number;
    body: string;
    headers: Record<string, unknown>;
    json: () => unknown;
  }>;
  close: () => Promise<void>;
}

export async function setup(
  names: string[],
  opts: { clock?: string; env?: Record<string, string>; timezone?: string } = {},
): Promise<Harness> {
  const fake = new FakeSparky();
  let clock = new Date(opts.clock ?? '2026-10-02T18:00:00Z');
  const sparky: Record<string, FakeUser> = {};
  for (const n of names)
    sparky[n] = fake.addUser({ id: `u-${n}`, email: `${n}@example.com`, password: 'pw', name: n });

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
    ...opts.env,
  });
  const { app, ctx } = await buildApp({
    db,
    cfg,
    sparky: new SparkyClient({ baseUrl: fake.baseUrl, fetch: fake.fetch }),
    now: () => clock,
  });

  const ids: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  // A fresh token per request, so moving the clock never signs anyone out.
  const raw: Harness['raw'] = async (who, method, url, payload, headers = {}) =>
    app.inject({
      method: method as 'GET',
      url,
      payload: payload as object,
      headers: {
        'x-gauntlet-client': 'native',
        ...(who ? { authorization: `Bearer ${await signAccessToken(ctx, ids[who]!)}` } : {}),
        ...headers,
      },
    });
  for (const n of names) {
    const r = await raw(null, 'POST', '/api/auth/login', {
      method: 'api_key',
      apiKey: fake.mintKey(`u-${n}`),
    });
    const body = r.json() as { accessToken: string; user: { id: string } };
    tokens[n] = body.accessToken;
    ids[n] = body.user.id;
  }
  if (opts.timezone) await db.execute(sql`update users set timezone = ${opts.timezone}`);
  // Signing in starts a background sync; let those finish so tests control all syncing from here.
  await new Promise((r) => setTimeout(r, 300));

  return {
    app,
    ctx,
    fake,
    ids,
    tokens,
    sparky,
    setClock: (iso) => {
      clock = new Date(iso);
    },
    raw,
    async call(who, method, url, payload) {
      const res = await raw(who, method, url, payload);
      if (res.statusCode >= 400)
        throw new Error(`${method} ${url} -> ${res.statusCode}: ${res.body}`);
      return res.json() as never;
    },
    close: async () => {
      await app.close();
      await client.end();
    },
  };
}

/** Make everyone friends with the first person through an invite link. */
export async function befriendAll(h: Harness, names: string[]) {
  const [first, ...rest] = names;
  const inv = await h.call<{ code: string }>(first!, 'POST', '/api/invites', { kind: 'friend' });
  for (const n of rest) await h.call(n, 'POST', `/api/invites/${inv.code}/accept`);
}
