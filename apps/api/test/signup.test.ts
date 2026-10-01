import type { MeUser, SourcesResponse } from '@gauntlet/shared';
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

beforeAll(async () => {
  const { db, client } = createDb(DB_URL);
  await db.execute(
    sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`,
  );
  await runMigrations(db);
  const cfg = loadConfig({
    DATABASE_URL: DB_URL,
    SPARKY_URL: fake.baseUrl,
    SPARKY_PUBLIC_URL: 'https://sparky.example.com/',
    PUBLIC_WEB_URL: 'https://gauntlet.test',
    JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    SYNC_INTERVAL_MINUTES: '0',
  });
  ({ app } = await buildApp({
    db,
    cfg,
    sparky: new SparkyClient({ baseUrl: fake.baseUrl, fetch: fake.fetch }),
    now: () => new Date(),
  }));
  closeDb = () => client.end();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

function signup(payload: object, ip = '203.0.113.7') {
  return app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload,
    headers: { 'x-gauntlet-client': 'native', 'fly-client-ip': ip },
  });
}

describe('sign up through Gauntlet', () => {
  it('creates the SparkyFitness account, keeps an API key and signs in', async () => {
    const res = await signup({
      name: ' Alex Morgan ',
      email: 'Alex@Example.com',
      password: 'long-enough',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; accessToken: string; user: MeUser };
    expect(body.status).toBe('ok');
    expect(body.user.displayName).toBe('Alex Morgan');
    expect(body.user.email).toBe('alex@example.com');

    const sparkyUser = [...fake.users.values()].find((u) => u.email === 'alex@example.com')!;
    // The sign-up session was traded for a key and signed out, like a password sign-in.
    expect(
      [...fake.tokens.values()].filter((t) => t.userId === sparkyUser.id).map((t) => t.kind),
    ).toEqual(['key']);
    // SparkyFitness rate-limits per person, not per Gauntlet server.
    expect(fake.forwardedFor).toContain('203.0.113.7');

    // The new account can sign in again with its password.
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { method: 'password', email: 'alex@example.com', password: 'long-enough' },
      headers: { 'x-gauntlet-client': 'native' },
    });
    expect(login.statusCode).toBe(200);

    // Links people follow point at the public SparkyFitness address, not the internal one.
    const sources = await app.inject({
      method: 'GET',
      url: '/api/sources',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect((sources.json() as SourcesResponse).integrationsUrl).toBe(
      'https://sparky.example.com/settings?section=integrations',
    );
  });

  it('explains duplicate emails, weak passwords and closed sign-ups', async () => {
    const dup = await signup({ name: 'A', email: 'alex@example.com', password: 'long-enough' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ code: 'email_taken' });

    const weak = await signup({ name: 'B', email: 'b@example.com', password: 'short' });
    expect(weak.statusCode).toBe(400);

    fake.signupDisabled = true;
    const closed = await signup(
      { name: 'C', email: 'c@example.com', password: 'long-enough' },
      '203.0.113.8',
    );
    expect(closed.statusCode).toBe(403);
    expect(closed.json()).toMatchObject({ code: 'signup_disabled' });
    fake.signupDisabled = false;
  });
});
