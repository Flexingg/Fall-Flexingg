import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { SparkyClient } from '../src/sparky/client.js';

const dir = mkdtempSync(join(tmpdir(), 'gauntlet-dl-'));
const apk = Buffer.from('PK\x03\x04 not really an apk');
writeFileSync(join(dir, 'gauntlet-v1.2.3.apk'), apk);
writeFileSync(join(dir, 'gauntlet-latest.apk'), apk);
writeFileSync(join(dir, 'secret.txt'), 'nope');
writeFileSync(
  join(dir, 'latest.json'),
  JSON.stringify({
    version: 'v1.2.3',
    builtAt: '2026-10-01T00:00:00Z',
    sha256: createHash('sha256').update(apk).digest('hex'),
    file: 'gauntlet-v1.2.3.apk',
    sizeBytes: apk.length,
  }),
);

const { db, client } = createDb('postgres://postgres@127.0.0.1:5433/gauntlet_test');
const base = {
  DATABASE_URL: 'postgres://unused',
  JWT_SECRET: 'x'.repeat(40),
  ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
};
const build = (extra: Record<string, string>) =>
  buildApp({
    db,
    cfg: loadConfig({ ...base, ...extra }),
    sparky: new SparkyClient({ baseUrl: 'https://sparky.test' }),
    now: () => new Date(),
  });

const { app } = await build({ DOWNLOADS_DIR: dir, ASSETLINKS_SHA256: 'AA:BB, CC:DD' });
afterAll(async () => {
  await app.close();
  await client.end();
});

describe('APK downloads', () => {
  it('serves the APK as a download with the right type and size', async () => {
    const res = await app.inject({ url: '/downloads/gauntlet-v1.2.3.apk' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.android.package-archive');
    expect(res.headers['content-disposition']).toContain(
      'attachment; filename="gauntlet-v1.2.3.apk"',
    );
    expect(res.headers['content-length']).toBe(String(apk.length));
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.rawPayload.equals(apk)).toBe(true);
  });

  it('never caches the moving "latest" link', async () => {
    const res = await app.inject({ url: '/downloads/gauntlet-latest.apk' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('only serves apk and json files, and never escapes the directory', async () => {
    for (const url of [
      '/downloads/secret.txt',
      '/downloads/..%2Fpackage.json',
      '/downloads/%2e%2e/x.apk',
      '/downloads/missing.apk',
    ]) {
      expect((await app.inject({ url })).statusCode).toBe(404);
    }
  });

  it('describes the latest release', async () => {
    const res = await app.inject({ url: '/api/app/android' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      version: 'v1.2.3',
      file: 'gauntlet-v1.2.3.apk',
      url: '/downloads/gauntlet-v1.2.3.apk',
      latestUrl: '/downloads/gauntlet-latest.apk',
      sizeBytes: apk.length,
    });
  });

  it('publishes App Links verification for invite links', async () => {
    const res = await app.inject({ url: '/.well-known/assetlinks.json' });
    expect(res.json()[0].target).toMatchObject({
      package_name: 'cc.randalls.gauntlet',
      sha256_cert_fingerprints: ['AA:BB', 'CC:DD'],
    });
  });

  it('404s cleanly when nothing has been released or hosting is off', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'gauntlet-empty-'));
    const a = (await build({ DOWNLOADS_DIR: empty })).app;
    expect((await a.inject({ url: '/api/app/android' })).json()).toMatchObject({
      code: 'no_release',
    });
    const b = (await build({})).app;
    expect((await b.inject({ url: '/downloads/gauntlet-latest.apk' })).statusCode).toBe(404);
    expect((await b.inject({ url: '/.well-known/assetlinks.json' })).statusCode).toBe(404);
    await a.close();
    await b.close();
  });
});
