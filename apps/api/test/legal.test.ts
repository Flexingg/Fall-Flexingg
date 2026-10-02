import { SparkyClient } from '@gauntlet/sparky';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';

const { db, client } = createDb('postgres://postgres@127.0.0.1:5433/gauntlet_test');
const { app } = await buildApp({
  db,
  cfg: loadConfig({
    DATABASE_URL: 'postgres://unused',
    JWT_SECRET: 'x'.repeat(40),
    ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
    PUBLIC_WEB_URL: 'https://gauntlet.example.com',
    ADMIN_EMAILS: 'boss@example.com',
  }),
  sparky: new SparkyClient({ baseUrl: 'https://sparky.test' }),
  now: () => new Date(),
});
afterAll(async () => {
  await app.close();
  await client.end();
});

describe('legal pages', () => {
  it('serves privacy, terms and account deletion without signing in', async () => {
    for (const path of ['/privacy', '/terms', '/delete-account']) {
      const res = await app.inject({ url: path });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('gauntlet.example.com');
    }
  });

  it('names the data collected and how to delete it, with the contact address', async () => {
    const res = await app.inject({ url: '/privacy' });
    expect(res.body).toContain('Health Connect');
    expect(res.body).toContain('Show Events');
    expect(res.body).toContain('mailto:boss@example.com');
    expect(res.body).toContain('/delete-account');
  });
});
