/**
 * Server admin: an overview of how the server is doing, and backups (list, back up now, download,
 * upload, restore, delete). Every route needs an admin and is written to the log with who did it.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rename, rm, stat, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  BACKUP_NAME_RE,
  backupScheduleSchema,
  DEFAULT_BACKUP_SCHEDULE,
  restoreBodySchema,
  type BackupSchedule,
  type AdminOverview,
  type BackupJob,
  type BackupsResponse,
  type DiskUsage,
} from '@gauntlet/shared';
import { and, count, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest, forbidden, HttpError, notFound } from '../context.js';
import { readAndroidRelease } from '../downloads.js';
import { challenges, friendships, users } from '../db/schema.js';
import {
  activeJob,
  backupExists,
  backupName,
  inspectTar,
  issueDownloadToken,
  listBackups,
  prepareBackupDir,
  pruneStatus,
  readJob,
  requestJob,
  serviceStatus,
  spendDownloadToken,
  sumFiles,
  readSchedule,
  saveSchedule,
} from '../services/backups.js';
import { lastSyncCycle } from '../services/syncStatus.js';
import { getUser, isAdmin } from '../services/users.js';

const MAX_UPLOAD_BYTES = 5 * 1024 ** 3;
const RESTART_COMMAND =
  'docker compose -f deploy/docker-compose.yml --env-file deploy/.env restart';

function appVersion(): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function disk(path: string | undefined): Promise<DiskUsage | null> {
  if (!path) return null;
  const usedBytes = await sumFiles(path);
  const fs = await statfs(path).catch(() => null);
  return {
    path,
    usedBytes,
    freeBytes: fs ? Number(fs.bavail) * Number(fs.bsize) : null,
    totalBytes: fs ? Number(fs.blocks) * Number(fs.bsize) : null,
  };
}

export function adminRoutes(app: FastifyInstance, ctx: AppContext) {
  const version = appVersion();
  const dir = ctx.cfg.BACKUP_DIR;
  if (dir) void prepareBackupDir(dir, version).catch((err) => ctx.log.warn({ err }, 'backup dir'));

  const requireAdmin = async (req: FastifyRequest) => {
    await requireUser(ctx)(req, undefined as never);
    const me = await getUser(ctx, req.userId);
    if (!isAdmin(ctx, me)) throw forbidden('Only server admins can do that');
  };
  const auth = { preHandler: requireAdmin };
  const audit = (req: FastifyRequest, what: string, extra: object = {}) =>
    ctx.log.info({ adminId: req.userId, ...extra }, `admin: ${what}`);
  const needDir = () => {
    if (!dir) throw new HttpError(409, 'Backups are not set up on this server', 'no_backups');
    return dir;
  };
  const validName = (name: string) => {
    if (!BACKUP_NAME_RE.test(name)) throw badRequest('That is not a backup name');
    return name;
  };

  app.get('/api/admin/overview', auth, async (req): Promise<AdminOverview> => {
    audit(req, 'overview');
    const [userCounts] = await ctx.db
      .select({
        users: count(),
        demo: sql<number>`count(*) filter (where ${users.isDemo})`.mapWith(Number),
      })
      .from(users);
    const [{ n: active } = { n: 0 }] = await ctx.db
      .select({ n: count() })
      .from(challenges)
      .where(isNull(challenges.finalizedAt));
    const [{ n: finished } = { n: 0 }] = await ctx.db
      .select({ n: count() })
      .from(challenges)
      .where(isNotNull(challenges.finalizedAt));
    const [{ n: friends } = { n: 0 }] = await ctx.db
      .select({ n: count() })
      .from(friendships)
      .where(eq(friendships.status, 'accepted'));
    const [latest] = await ctx.db
      .select({ at: sql<Date | null>`max(${users.lastSyncedAt})` })
      .from(users);
    const problems = await ctx.db
      .select()
      .from(users)
      .where(and(isNotNull(users.lastSyncError), eq(users.isDemo, false)))
      .orderBy(desc(users.lastSyncErrorAt))
      .limit(50);
    const invalid = await ctx.db
      .select({ id: users.id, name: users.displayName })
      .from(users)
      .where(and(ne(users.keyStatus, 'active'), eq(users.isDemo, false)))
      .limit(50);
    const sizes = await ctx.db.execute<{ name: string; bytes: string }>(
      sql`select datname as name, pg_database_size(oid)::text as bytes from pg_database
          where datname in (current_database(), 'sparkyfitness_db')`,
    );
    const sizeOf = (n: string) => {
      const r = sizes.find((s) => s.name === n);
      return r ? Number(r.bytes) : null;
    };
    const currentDb = await ctx.db.execute<{ d: string }>(sql`select current_database() as d`);
    const release = ctx.cfg.DOWNLOADS_DIR ? await readAndroidRelease(ctx.cfg.DOWNLOADS_DIR) : null;
    const cycle = lastSyncCycle();

    let backups: AdminOverview['backups'] = {
      configured: false,
      count: 0,
      last: null,
      serviceRunning: false,
      current: null,
    };
    if (dir) {
      const st = await serviceStatus(dir);
      backups = {
        configured: true,
        count: (await listBackups(dir)).length,
        last: st.last,
        serviceRunning: st.serviceRunning,
        current: st.current,
      };
    }
    return {
      version,
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      counts: {
        users: Number(userCounts!.users) - Number(userCounts!.demo),
        demoUsers: Number(userCounts!.demo),
        activeChallenges: active,
        finishedChallenges: finished,
        friendships: friends,
      },
      sync: {
        lastCycle: cycle
          ? { at: cycle.at.toISOString(), ok: cycle.ok, failed: cycle.failed }
          : null,
        lastUserSyncAt: latest?.at ? new Date(latest.at).toISOString() : null,
        problems: problems.map((u) => ({
          userId: u.id,
          name: u.displayName,
          error: u.lastSyncError ?? '',
          at: u.lastSyncErrorAt?.toISOString() ?? null,
        })),
        invalidKeys: invalid.map((u) => ({ userId: u.id, name: u.name })),
      },
      database: {
        gauntletBytes: sizeOf(currentDb[0]?.d ?? 'gauntlet') ?? 0,
        sparkyBytes: sizeOf('sparkyfitness_db'),
      },
      storage: { downloads: await disk(ctx.cfg.DOWNLOADS_DIR), backups: await disk(dir) },
      android: release
        ? { version: release.version, builtAt: release.builtAt, sizeBytes: release.sizeBytes }
        : null,
      backups,
    };
  });

  app.get('/api/admin/backups', auth, async (req): Promise<BackupsResponse> => {
    audit(req, 'list backups');
    if (!dir)
      return {
        configured: false,
        backups: [],
        current: null,
        last: null,
        nextAt: null,
        keep: null,
        schedule: DEFAULT_BACKUP_SCHEDULE,
        serviceRunning: false,
        restartCommand: RESTART_COMMAND,
      };
    void pruneStatus(dir);
    const st = await serviceStatus(dir);
    return {
      configured: true,
      backups: await listBackups(dir),
      current: st.current ?? (await activeJob(dir)),
      last: st.last,
      nextAt: st.nextAt,
      keep: st.keep,
      schedule: await readSchedule(dir),
      serviceRunning: st.serviceRunning,
      restartCommand: RESTART_COMMAND,
    };
  });

  /** How often automatic backups run and how long backups are kept. */
  app.put('/api/admin/backups/schedule', auth, async (req): Promise<BackupSchedule> => {
    const d = needDir();
    const schedule = backupScheduleSchema.parse(req.body);
    await saveSchedule(d, schedule);
    audit(req, 'backup schedule changed', schedule);
    return schedule;
  });

  app.post('/api/admin/backups', auth, async (req, reply): Promise<BackupJob> => {
    const d = needDir();
    if (await activeJob(d))
      throw new HttpError(409, 'A backup or restore is already running', 'busy');
    await prepareBackupDir(d, version);
    const job = await requestJob(d, { action: 'backup' });
    audit(req, 'backup requested', { jobId: job.id });
    reply.code(202);
    return job;
  });

  app.get<{ Params: { id: string } }>('/api/admin/backups/jobs/:id', auth, async (req) => {
    const job = await readJob(needDir(), req.params.id);
    if (!job) throw notFound('No such job');
    return job;
  });

  // Raw file body, streamed straight to disk, then checked before it is allowed to appear in the list.
  app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', (_req, payload, done) =>
      done(null, payload),
    );
    scope.post(
      '/api/admin/backups/upload',
      { ...auth, bodyLimit: MAX_UPLOAD_BYTES },
      async (req, reply) => {
        const d = needDir();
        const name = backupName(ctx.now(), '-uploaded');
        if (await backupExists(d, name)) throw new HttpError(409, 'Try again in a moment', 'busy');
        const partial = join(d, `.upload-${req.id.replace(/\W/g, '')}-${Date.now()}.partial`);
        let seen = 0;
        const limit = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            seen += chunk.length;
            cb(
              seen > MAX_UPLOAD_BYTES
                ? new HttpError(413, 'That file is too big', 'too_big')
                : null,
              chunk,
            );
          },
        });
        try {
          await pipeline(
            req.body as NodeJS.ReadableStream,
            limit,
            createWriteStream(partial, { mode: 0o644 }),
          );
          const check = await inspectTar(partial);
          if (!check.ok) throw badRequest(check.reason ?? 'Not a Gauntlet backup', 'bad_backup');
          await rename(partial, join(d, name));
        } catch (err) {
          await rm(partial, { force: true });
          throw err;
        }
        audit(req, 'backup uploaded', { name, sizeBytes: seen });
        reply.code(201);
        return { name, sizeBytes: seen };
      },
    );
  });

  app.post<{ Params: { name: string } }>(
    '/api/admin/backups/:name/download-token',
    auth,
    async (req) => {
      const d = needDir();
      const name = validName(req.params.name);
      if (!(await backupExists(d, name))) throw notFound('Backup not found');
      const token = issueDownloadToken(name, req.userId);
      audit(req, 'download link made', { name });
      return {
        url: `/api/admin/backups/${name}/download?token=${token}`,
        expiresInSeconds: 60,
      };
    },
  );

  // Plain link: the single-use token stands in for the sign-in header (or an admin can send the header).
  app.get<{ Params: { name: string }; Querystring: { token?: string } }>(
    '/api/admin/backups/:name/download',
    async (req, reply) => {
      const d = needDir();
      const name = validName(req.params.name);
      let adminId: string;
      if (req.query.token) {
        const t = spendDownloadToken(req.query.token, name);
        if (!t) throw new HttpError(401, 'This download link has expired', 'token_expired');
        adminId = t.adminId;
      } else {
        await requireAdmin(req);
        adminId = req.userId;
      }
      const info = await stat(join(d, name)).catch(() => null);
      if (!info?.isFile()) throw notFound('Backup not found');
      ctx.log.info({ adminId, name }, 'admin: backup downloaded');
      reply
        .header('Content-Type', 'application/x-tar')
        .header('Content-Length', info.size)
        .header('Content-Disposition', `attachment; filename="${name}"`)
        .header('Cache-Control', 'no-store');
      return reply.send(createReadStream(join(d, name)));
    },
  );

  app.delete<{ Params: { name: string } }>('/api/admin/backups/:name', auth, async (req) => {
    const d = needDir();
    const name = validName(req.params.name);
    if (!(await backupExists(d, name))) throw notFound('Backup not found');
    const job = await activeJob(d);
    if (job?.file === name)
      throw new HttpError(409, 'That backup is being restored right now', 'busy');
    await rm(join(d, name));
    audit(req, 'backup deleted', { name });
    return { ok: true };
  });

  app.post<{ Params: { name: string } }>(
    '/api/admin/backups/:name/restore',
    auth,
    async (req, reply) => {
      const d = needDir();
      const name = validName(req.params.name);
      const parsed = restoreBodySchema.safeParse(req.body);
      if (!parsed.success) throw badRequest('Type RESTORE to confirm', 'confirm_required');
      if (!(await backupExists(d, name))) throw notFound('Backup not found');
      const check = await inspectTar(join(d, name));
      if (!check.ok) throw badRequest(check.reason ?? 'Not a Gauntlet backup', 'bad_backup');
      if (await activeJob(d))
        throw new HttpError(409, 'A backup or restore is already running', 'busy');
      await prepareBackupDir(d, version);
      const job = await requestJob(d, { action: 'restore', file: name });
      audit(req, 'restore requested', { name, jobId: job.id });
      reply.code(202);
      return job;
    },
  );
}
