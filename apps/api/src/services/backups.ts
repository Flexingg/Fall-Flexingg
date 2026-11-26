/**
 * The API's side of backups. The `backup` compose service does the real work (pg_dump, restore);
 * the two talk through files in BACKUP_DIR: backups are `gauntlet-backup-*.tar`, requests go in
 * `.requests/`, progress comes back in `.status/`. Nothing here touches the database.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BACKUP_JOB_ID_RE,
  BACKUP_NAME_RE,
  backupKind,
  type BackupInfo,
  type BackupJob,
} from '@gauntlet/shared';

const REQUESTS = '.requests';
const STATUS = '.status';
/** The backup service checks in every few seconds; this long without a check-in means it is down. */
const HEARTBEAT_STALE_MS = 60_000;

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Write to a temp name and rename, so a reader never sees half a file. */
async function writeJsonAtomic(path: string, data: unknown) {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(data), { mode: 0o644 });
  await rename(tmp, path);
}

export async function prepareBackupDir(dir: string, appVersion: string) {
  await mkdir(join(dir, REQUESTS), { recursive: true, mode: 0o777 });
  await mkdir(join(dir, STATUS), { recursive: true, mode: 0o777 });
  // Lets the backup service put the app version in each backup's manifest.
  await writeFile(join(dir, '.app-version'), appVersion).catch(() => undefined);
}

export async function listBackups(dir: string): Promise<BackupInfo[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: BackupInfo[] = [];
  for (const name of names) {
    if (!BACKUP_NAME_RE.test(name)) continue;
    const info = await stat(join(dir, name)).catch(() => null);
    if (!info?.isFile()) continue;
    out.push({
      name,
      sizeBytes: info.size,
      createdAt: info.mtime.toISOString(),
      kind: backupKind(name),
    });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
}

export async function backupExists(dir: string, name: string): Promise<boolean> {
  if (!BACKUP_NAME_RE.test(name)) return false;
  return (await stat(join(dir, name)).catch(() => null))?.isFile() ?? false;
}

export const readJob = (dir: string, id: string) =>
  BACKUP_JOB_ID_RE.test(id) ? readJson<BackupJob>(join(dir, STATUS, `${id}.json`)) : null;

export async function serviceStatus(dir: string) {
  const beat = await readJson<{ at?: number }>(join(dir, STATUS, 'heartbeat.json'));
  const schedule = await readJson<{ nextAt?: string; keep?: number }>(
    join(dir, STATUS, 'schedule.json'),
  );
  const current = await readJson<BackupJob>(join(dir, STATUS, 'current.json'));
  const last = await readJson<{ file: string; sizeBytes: number; createdAt: string }>(
    join(dir, STATUS, 'last-backup.json'),
  );
  return {
    serviceRunning: !!beat?.at && Date.now() - beat.at * 1000 < HEARTBEAT_STALE_MS,
    nextAt: schedule?.nextAt ?? null,
    keep: schedule?.keep ?? null,
    current: current && current.state === 'running' ? current : null,
    last,
  };
}

/** A job that has not finished (so a second one should wait). */
export async function activeJob(dir: string): Promise<BackupJob | null> {
  const names = await readdir(join(dir, STATUS)).catch(() => [] as string[]);
  for (const n of names) {
    if (!n.endsWith('.json') || n === 'current.json') continue;
    const job = await readJson<BackupJob>(join(dir, STATUS, n));
    if (job && (job.state === 'queued' || job.state === 'running')) {
      // A job that has sat queued for a long while was lost (service restarted): ignore it.
      const age = Date.now() - ((await stat(join(dir, STATUS, n)).catch(() => null))?.mtimeMs ?? 0);
      if (job.state === 'queued' && age > 10 * 60_000) continue;
      return job;
    }
  }
  return null;
}

export async function requestJob(
  dir: string,
  req: { action: 'backup' } | { action: 'restore'; file: string },
): Promise<BackupJob> {
  const id = randomUUID();
  const job: BackupJob = {
    id,
    action: req.action,
    state: 'queued',
    message: 'Waiting for the backup service',
    file: 'file' in req ? req.file : null,
    startedAt: null,
    finishedAt: null,
  };
  // Status first, so polling works at once; the service overwrites it when it starts.
  await writeJsonAtomic(join(dir, STATUS, `${id}.json`), job);
  await writeJsonAtomic(join(dir, REQUESTS, `${id}.json`), req);
  return job;
}

/** Remove job status files older than a week, so the folder doesn't grow forever. */
export async function pruneStatus(dir: string) {
  const names = await readdir(join(dir, STATUS)).catch(() => [] as string[]);
  for (const n of names) {
    if (!/^[A-Za-z0-9-]{8,64}\.json$/.test(n)) continue;
    const info = await stat(join(dir, STATUS, n)).catch(() => null);
    if (info && Date.now() - info.mtimeMs > 7 * 86_400_000)
      await rm(join(dir, STATUS, n), { force: true });
  }
}

/** Folder size and free space, for the Storage section. */
export async function sumFiles(dir: string, depth = 3): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isFile()) total += (await stat(p).catch(() => null))?.size ?? 0;
    else if (e.isDirectory() && depth > 0) total += await sumFiles(p, depth - 1);
  }
  return total;
}

/** Name for a backup the API creates itself (upload), same shape the backup service uses. */
export function backupName(now: Date, suffix: '-uploaded'): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const ts =
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `gauntlet-backup-${ts}${suffix}.tar`;
}

/** Files a backup must contain to be restorable. */
const REQUIRED = ['manifest.json', 'gauntlet.dump', 'sparkyfitness_db.dump'];

/**
 * Check a file is a tar holding what a restore needs, by walking the 512-byte headers (no
 * extraction, so it is fast and safe on junk). Returns the member names found.
 */
export async function inspectTar(path: string): Promise<{ ok: boolean; reason?: string }> {
  const fh = await open(path, constants.O_RDONLY).catch(() => null);
  if (!fh) return { ok: false, reason: 'Could not read the file' };
  try {
    const size = (await fh.stat()).size;
    const found = new Set<string>();
    const head = Buffer.alloc(512);
    let pos = 0;
    let longName: string | null = null;
    while (pos + 512 <= size) {
      await fh.read(head, 0, 512, pos);
      if (head.every((b) => b === 0)) break;
      const magic = head.subarray(257, 262).toString('latin1');
      if (magic !== 'ustar') return { ok: false, reason: 'Not a backup file (not a tar archive)' };
      const sum = head.reduce((a, b, i) => a + (i >= 148 && i < 156 ? 32 : b), 0);
      const stored = parseInt(head.subarray(148, 154).toString('latin1').trim() || 'x', 8);
      if (stored !== sum) return { ok: false, reason: 'The file is damaged (bad tar header)' };
      const sizeField = head.subarray(124, 136);
      let entrySize: number;
      if (sizeField[0]! & 0x80) {
        entrySize = 0;
        for (let i = 1; i < 12; i++) entrySize = entrySize * 256 + sizeField[i]!;
      } else
        entrySize = parseInt(sizeField.toString('latin1').replace(/\0.*$/, '').trim() || '0', 8);
      const type = String.fromCharCode(head[156]!);
      const cstr = (b: Buffer) => b.toString('utf8').replace(/\0.*$/s, '');
      const prefix = cstr(head.subarray(345, 500));
      let name = prefix ? `${prefix}/${cstr(head.subarray(0, 100))}` : cstr(head.subarray(0, 100));
      if (type === 'L') {
        const buf = Buffer.alloc(Math.min(entrySize, 4096));
        await fh.read(buf, 0, buf.length, pos + 512);
        longName = cstr(buf);
      } else {
        if (longName) name = longName;
        longName = null;
        if (type === '0' || type === '\0') found.add(name.replace(/^\.\//, ''));
      }
      pos += 512 + Math.ceil(entrySize / 512) * 512;
    }
    const missing = REQUIRED.filter((r) => !found.has(r));
    if (missing.length)
      return { ok: false, reason: `This is not a Gauntlet backup (missing ${missing.join(', ')})` };
    return { ok: true };
  } finally {
    await fh.close();
  }
}

/** Short-lived, single-use links so a plain browser download works without the auth header. */
const TOKEN_TTL_MS = 60_000;
const tokens = new Map<string, { name: string; adminId: string; expires: number }>();

export function issueDownloadToken(name: string, adminId: string, now = Date.now()): string {
  for (const [t, v] of tokens) if (v.expires < now) tokens.delete(t);
  const token = randomBytes(24).toString('base64url');
  tokens.set(token, { name, adminId, expires: now + TOKEN_TTL_MS });
  return token;
}

/** Spend a token: valid once, for that file only, within 60 seconds. */
export function spendDownloadToken(token: string, name: string, now = Date.now()) {
  const t = tokens.get(token);
  tokens.delete(token);
  if (!t || t.expires < now || t.name !== name) return null;
  return t;
}
