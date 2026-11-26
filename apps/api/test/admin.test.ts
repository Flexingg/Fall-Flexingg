import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdminOverview, BackupJob, BackupsResponse, MeUser } from '@gauntlet/shared';
import { SparkyClient } from '@gauntlet/sparky';
import { FakeSparky } from '@gauntlet/sparky/testing';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { users } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { syncUser } from '../src/services/sync.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/gauntlet_test';
const fake = new FakeSparky();
const dir = mkdtempSync(join(tmpdir(), 'gauntlet-backups-'));
let app: FastifyInstance;
let closeDb: () => Promise<void>;
let db: ReturnType<typeof createDb>['db'];
const who = { admin: 'boss@example.com', ana: 'ana@example.com' };
type Who = keyof typeof who;
const access: Partial<Record<Who, string>> = {};
const ids: Partial<Record<Who, string>> = {};

/** A minimal ustar archive, like the one the backup service writes. */
function tar(entries: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, body] of Object.entries(entries)) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 'utf8');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${Buffer.byteLength(body).toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    const sum = h.reduce((a, b) => a + b, 0);
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, Buffer.from(body), Buffer.alloc((512 - (Buffer.byteLength(body) % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
const goodTar = () =>
  tar({ 'manifest.json': '{}', 'gauntlet.dump': 'x', 'sparkyfitness_db.dump': 'y' });

beforeAll(async () => {
  const created = createDb(DB_URL);
  db = created.db;
  closeDb = () => created.client.end();
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
    BACKUP_DIR: dir,
    DOWNLOADS_DIR: dir,
  });
  ({ app } = await buildApp({
    db,
    cfg,
    sparky: new SparkyClient({ baseUrl: fake.baseUrl, fetch: fake.fetch }),
    now: () => new Date(),
  }));
  for (const [w, email] of Object.entries(who) as [Who, string][]) {
    fake.addUser({ id: `u-${w}`, email, password: `pw-${w}`, name: w });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { method: 'password', email, password: `pw-${w}` },
      headers: { 'x-gauntlet-client': 'native' },
    });
    const body = res.json() as { accessToken: string; user: MeUser };
    access[w] = body.accessToken;
    ids[w] = body.user.id;
  }
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

async function call<T = unknown>(
  w: Who,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  expectStatus = 200,
): Promise<T> {
  const res = await app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${access[w]}` },
  });
  if (res.statusCode !== expectStatus)
    throw new Error(`${method} ${url} -> ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}

const NAME = 'gauntlet-backup-20260101-033000.tar';
const seed = (name = NAME, body: Buffer = goodTar()) => writeFileSync(join(dir, name), body);

describe('admin routes are for admins only', () => {
  it('answers 403 to a normal user on every route (and 401 with no sign-in)', async () => {
    seed();
    const routes: ['GET' | 'POST' | 'DELETE', string][] = [
      ['GET', '/api/admin/overview'],
      ['GET', '/api/admin/backups'],
      ['POST', '/api/admin/backups'],
      ['POST', '/api/admin/backups/upload'],
      ['GET', `/api/admin/backups/${NAME}/download`],
      ['POST', `/api/admin/backups/${NAME}/download-token`],
      ['DELETE', `/api/admin/backups/${NAME}`],
      ['POST', `/api/admin/backups/${NAME}/restore`],
      ['GET', '/api/admin/backups/jobs/abcdefgh-1'],
    ];
    for (const [method, url] of routes) {
      const res = await app.inject({
        method,
        url,
        headers: {
          authorization: `Bearer ${access.ana}`,
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        payload: method === 'POST' ? '{}' : undefined,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      const anon = await app.inject({ method, url });
      expect(anon.statusCode, `anon ${method} ${url}`).toBe(401);
    }
    expect(existsSync(join(dir, NAME))).toBe(true);
  });
});

describe('overview', () => {
  it('reports health, counts, sync problems and storage', async () => {
    await db
      .update(users)
      .set({ lastSyncError: 'SparkyFitness timed out', lastSyncErrorAt: new Date() })
      .where(eq(users.id, ids.ana!));
    const o = await call<AdminOverview>('admin', 'GET', '/api/admin/overview');
    expect(o.version).toBeTruthy();
    expect(o.nodeVersion).toBe(process.version);
    expect(o.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(o.counts.users).toBeGreaterThanOrEqual(2);
    expect(o.counts).toMatchObject({ activeChallenges: 0, finishedChallenges: 0, friendships: 0 });
    expect(o.sync.problems).toEqual([
      expect.objectContaining({ userId: ids.ana, error: 'SparkyFitness timed out' }),
    ]);
    expect(o.database.gauntletBytes).toBeGreaterThan(0);
    expect(o.storage.backups).toMatchObject({ path: dir });
    expect(o.storage.backups!.usedBytes).toBeGreaterThan(0);
    expect(o.storage.backups!.freeBytes).toBeGreaterThan(0);
    expect(o.backups).toMatchObject({ configured: true, count: 1, serviceRunning: false });
    expect(o.android).toBeNull();
  });
});

describe('sync problems are remembered', () => {
  it('sets the error when a sync fails and clears it when one works', async () => {
    const ctx = {
      db,
      cfg: loadConfig({
        DATABASE_URL: DB_URL,
        JWT_SECRET: 'x'.repeat(40),
        ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      }),
      sparky: new SparkyClient({ baseUrl: fake.baseUrl, fetch: fake.fetch }),
      log: app.log,
      now: () => new Date(),
    };
    const row = async () => (await db.select().from(users).where(eq(users.id, ids.ana!)))[0]!;
    await db.update(users).set({ keyStatus: 'invalid' }).where(eq(users.id, ids.ana!));
    expect((await syncUser(ctx, ids.ana!)).ok).toBe(false);
    expect((await row()).lastSyncError).toBe('SparkyFitness key is not valid');
    const o = await call<AdminOverview>('admin', 'GET', '/api/admin/overview');
    expect(o.sync.invalidKeys.map((k) => k.userId)).toContain(ids.ana);
    await db.update(users).set({ keyStatus: 'active' }).where(eq(users.id, ids.ana!));
    expect((await syncUser(ctx, ids.ana!)).ok).toBe(true);
    expect((await row()).lastSyncError).toBeNull();
  });
});

describe('backups', () => {
  it('lists backups with their kind, newest first, ignoring other files', async () => {
    seed('gauntlet-backup-20260102-033000-manual.tar');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, '.partial-gauntlet-backup-20260103-000000.tar'), 'x');
    const r = await call<BackupsResponse>('admin', 'GET', '/api/admin/backups');
    expect(r.configured).toBe(true);
    expect(r.backups.map((b) => [b.name, b.kind])).toEqual(
      expect.arrayContaining([
        [NAME, 'auto'],
        ['gauntlet-backup-20260102-033000-manual.tar', 'manual'],
      ]),
    );
    expect(r.backups.some((b) => b.name === 'notes.txt')).toBe(false);
    expect(r.restartCommand).toContain('docker compose');
  });

  it('shows the backup service state from the files it writes', async () => {
    await mkdir(join(dir, '.status'), { recursive: true });
    writeFileSync(
      join(dir, '.status', 'heartbeat.json'),
      JSON.stringify({ at: Math.floor(Date.now() / 1000) }),
    );
    writeFileSync(
      join(dir, '.status', 'schedule.json'),
      JSON.stringify({ nextAt: '2026-01-02T08:30:00Z', keep: 14 }),
    );
    writeFileSync(
      join(dir, '.status', 'last-backup.json'),
      JSON.stringify({ file: NAME, sizeBytes: 5, createdAt: '2026-01-01T08:30:00Z' }),
    );
    const r = await call<BackupsResponse>('admin', 'GET', '/api/admin/backups');
    expect(r).toMatchObject({ serviceRunning: true, nextAt: '2026-01-02T08:30:00Z', keep: 14 });
    expect(r.last?.file).toBe(NAME);
  });

  it('requests a backup by writing a request file, and reads the job status back', async () => {
    const job = await call<BackupJob>('admin', 'POST', '/api/admin/backups', {}, 202);
    expect(job.state).toBe('queued');
    const req = JSON.parse(readFileSync(join(dir, '.requests', `${job.id}.json`), 'utf8'));
    expect(req).toEqual({ action: 'backup' });
    // Another one while it is waiting is refused.
    await call('admin', 'POST', '/api/admin/backups', {}, 409);
    // The backup service updates the status; the API passes it on.
    const done = { ...job, state: 'done', message: 'Backup saved', finishedAt: 'now' };
    writeFileSync(join(dir, '.status', `${job.id}.json`), JSON.stringify(done));
    expect(
      await call<BackupJob>('admin', 'GET', `/api/admin/backups/jobs/${job.id}`),
    ).toMatchObject({ state: 'done', message: 'Backup saved' });
    await call('admin', 'GET', '/api/admin/backups/jobs/does-not-exist', undefined, 404);
  });

  it('hands out a download link that works once, for that file, within a minute', async () => {
    const { url } = await call<{ url: string }>(
      'admin',
      'POST',
      `/api/admin/backups/${NAME}/download-token`,
    );
    expect(url).toMatch(/\?token=/);
    const ok = await app.inject({ method: 'GET', url });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-disposition']).toContain(`filename="${NAME}"`);
    expect(ok.rawPayload.equals(goodTar())).toBe(true);
    // Spent.
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    // A link for one file does not open another.
    const other = 'gauntlet-backup-20260102-033000-manual.tar';
    const { url: u2 } = await call<{ url: string }>(
      'admin',
      'POST',
      `/api/admin/backups/${NAME}/download-token`,
    );
    const token = new URL(u2, 'http://x').searchParams.get('token');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/admin/backups/${other}/download?token=${token}`,
        })
      ).statusCode,
    ).toBe(401);
    // An admin can also download with the sign-in header.
    const hdr = await app.inject({
      method: 'GET',
      url: `/api/admin/backups/${NAME}/download`,
      headers: { authorization: `Bearer ${access.admin}` },
    });
    expect(hdr.statusCode).toBe(200);
  });

  it('expires download links after 60 seconds', async () => {
    const { issueDownloadToken, spendDownloadToken } = await import('../src/services/backups.js');
    const t = issueDownloadToken(NAME, 'x', 1_000);
    expect(spendDownloadToken(t, NAME, 1_000 + 61_000)).toBeNull();
    const t2 = issueDownloadToken(NAME, 'x', 1_000);
    expect(spendDownloadToken(t2, NAME, 1_000 + 59_000)).not.toBeNull();
  });

  it('rejects names that are not backups, including path tricks', async () => {
    for (const bad of [
      '..%2F..%2Fetc%2Fpasswd',
      '..',
      'secret.txt',
      'gauntlet-backup-1.tar',
      'gauntlet-backup-20260101-033000.tar%2F..%2Fx',
    ]) {
      for (const [method, url] of [
        ['POST', `/api/admin/backups/${bad}/download-token`],
        ['GET', `/api/admin/backups/${bad}/download?token=x`],
        ['DELETE', `/api/admin/backups/${bad}`],
        ['POST', `/api/admin/backups/${bad}/restore`],
      ] as const) {
        const res = await app.inject({
          method,
          url,
          headers: { authorization: `Bearer ${access.admin}` },
          payload: method === 'POST' ? { confirm: 'RESTORE' } : undefined,
        });
        expect([400, 404], `${method} ${url} -> ${res.statusCode}`).toContain(res.statusCode);
      }
    }
    expect(existsSync(join(dir, NAME))).toBe(true);
  });

  it('restore needs the word RESTORE and a backup that exists', async () => {
    const url = `/api/admin/backups/${NAME}/restore`;
    await call('admin', 'POST', url, {}, 400);
    await call('admin', 'POST', url, { confirm: 'restore' }, 400);
    await call(
      'admin',
      'POST',
      '/api/admin/backups/gauntlet-backup-20200101-000000.tar/restore',
      { confirm: 'RESTORE' },
      404,
    );
    // Clear the earlier queued job so a new one can start.
    for (const f of readdirSync(join(dir, '.status')))
      if (/^[a-f0-9-]{36}\.json$/.test(f))
        writeFileSync(join(dir, '.status', f), JSON.stringify({ state: 'done' }));
    const job = await call<BackupJob>('admin', 'POST', url, { confirm: 'RESTORE' }, 202);
    expect(job).toMatchObject({ action: 'restore', file: NAME, state: 'queued' });
    expect(JSON.parse(readFileSync(join(dir, '.requests', `${job.id}.json`), 'utf8'))).toEqual({
      action: 'restore',
      file: NAME,
    });
    // Not while it is being restored.
    await call('admin', 'DELETE', `/api/admin/backups/${NAME}`, undefined, 409);
    writeFileSync(
      join(dir, '.status', `${job.id}.json`),
      JSON.stringify({ ...job, state: 'done' }),
    );
  });

  it('will not restore a file that is not really a backup', async () => {
    const junk = 'gauntlet-backup-20260105-033000-uploaded.tar';
    writeFileSync(join(dir, junk), 'definitely not a tar file');
    const res = await call<{ code: string }>(
      'admin',
      'POST',
      `/api/admin/backups/${junk}/restore`,
      { confirm: 'RESTORE' },
      400,
    );
    expect(res.code).toBe('bad_backup');
  });

  it('accepts an uploaded backup and rejects junk without leaving it behind', async () => {
    const send = (body: Buffer) =>
      app.inject({
        method: 'POST',
        url: '/api/admin/backups/upload',
        headers: {
          authorization: `Bearer ${access.admin}`,
          'content-type': 'application/octet-stream',
        },
        payload: body,
      });
    const bad = await send(Buffer.from('this is not a tar'));
    expect(bad.statusCode).toBe(400);
    const missing = await send(tar({ 'manifest.json': '{}' }));
    expect(missing.statusCode).toBe(400);
    expect(readdirSync(dir).filter((f) => f.startsWith('.upload'))).toEqual([]);
    const ok = await send(goodTar());
    expect(ok.statusCode).toBe(201);
    const { name } = ok.json() as { name: string };
    expect(name).toMatch(/-uploaded\.tar$/);
    const r = await call<BackupsResponse>('admin', 'GET', '/api/admin/backups');
    expect(r.backups.find((b) => b.name === name)?.kind).toBe('uploaded');
  });

  it('deletes a backup', async () => {
    const name = 'gauntlet-backup-20260106-033000-manual.tar';
    seed(name);
    await call('admin', 'DELETE', `/api/admin/backups/${name}`);
    expect(existsSync(join(dir, name))).toBe(false);
    await call('admin', 'DELETE', `/api/admin/backups/${name}`, undefined, 404);
  });
});

describe('backup schedule', () => {
  const weekly = {
    frequency: 'weekly',
    time: '04:15',
    weekday: 0,
    dayOfMonth: 1,
    keepCount: 8,
    keepDays: 60,
  };

  it('defaults until an admin saves one, then the backup service gets it in the folder', async () => {
    const before = await call<BackupsResponse>('admin', 'GET', '/api/admin/backups');
    expect(before.schedule).toMatchObject({ frequency: 'daily', keepCount: 14, keepDays: 0 });
    await call('admin', 'PUT', '/api/admin/backups/schedule', weekly);
    expect(JSON.parse(readFileSync(join(dir, '.config', 'schedule.json'), 'utf8'))).toEqual(weekly);
    const after = await call<BackupsResponse>('admin', 'GET', '/api/admin/backups');
    expect(after.schedule).toEqual(weekly);
  });

  it('rejects bad schedules and non-admins', async () => {
    await call('admin', 'PUT', '/api/admin/backups/schedule', { ...weekly, time: '25:00' }, 400);
    await call(
      'admin',
      'PUT',
      '/api/admin/backups/schedule',
      { ...weekly, frequency: 'yearly' },
      400,
    );
    await call('admin', 'PUT', '/api/admin/backups/schedule', { ...weekly, dayOfMonth: 31 }, 400);
    await call('admin', 'PUT', '/api/admin/backups/schedule', { ...weekly, keepDays: -1 }, 400);
    await call('ana', 'PUT', '/api/admin/backups/schedule', weekly, 403);
  });
});

describe('without a backup folder', () => {
  it('says backups are not set up', async () => {
    const created = createDb(DB_URL);
    const cfg = loadConfig({
      DATABASE_URL: DB_URL,
      JWT_SECRET: 'test-secret-test-secret-test-secret-123',
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      ADMIN_EMAILS: 'boss@example.com',
    });
    const { app: bare } = await buildApp({
      db: created.db,
      cfg,
      sparky: new SparkyClient({ baseUrl: fake.baseUrl, fetch: fake.fetch }),
      now: () => new Date(),
    });
    const h = { authorization: `Bearer ${access.admin}` };
    const list = await bare.inject({ url: '/api/admin/backups', headers: h });
    expect(list.json()).toMatchObject({ configured: false, backups: [] });
    expect(
      (await bare.inject({ method: 'POST', url: '/api/admin/backups', headers: h })).statusCode,
    ).toBe(409);
    const o = (
      await bare.inject({ url: '/api/admin/overview', headers: h })
    ).json() as AdminOverview;
    expect(o.backups.configured).toBe(false);
    expect(o.storage.backups).toBeNull();
    await bare.close();
    await created.client.end();
  });
});
