import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { SparkyClient } from '@gauntlet/sparky';

const dist = mkdtempSync(join(tmpdir(), 'gauntlet-web-'));
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Gauntlet</title>');
mkdirSync(join(dist, 'assets'));
writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');

const { db, client } = createDb('postgres://postgres@127.0.0.1:5433/gauntlet_test');
const cfg = loadConfig({
  DATABASE_URL: 'postgres://unused',
  JWT_SECRET: 'x'.repeat(40),
  ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  WEB_DIST: dist,
});
const { app } = await buildApp({
  db,
  cfg,
  sparky: new SparkyClient({ baseUrl: 'https://sparky.test' }),
  now: () => new Date(),
});
afterAll(async () => {
  await app.close();
  await client.end();
});

describe('serving the PWA', () => {
  it('falls back to index.html for app routes', async () => {
    const res = await app.inject({ url: '/c/123/result' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>Gauntlet</title>');
    expect(res.headers['cache-control']).toBe('no-cache');
  });
  it('caches hashed assets forever', async () => {
    const res = await app.inject({ url: '/assets/app-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('immutable');
  });
  it('keeps unknown API routes as JSON 404s', async () => {
    const res = await app.inject({ url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not_found' });
  });
});
