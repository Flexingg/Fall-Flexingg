import {
  HEALTH_INGEST_TYPES,
  ingestSchema,
  sleepDaysSchema,
  type SourcesResponse,
} from '@gauntlet/shared';
import {
  describeSources,
  removeMissingSleep,
  replaceSleep,
  sleepRecordsOf,
} from '@gauntlet/sparky';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest } from '../context.js';
import { feedFor } from '../services/feed.js';
import { syncUser } from '../services/sync.js';
import { getUser, sparkyToken } from '../services/users.js';

const INGEST_TYPES = new Set(HEALTH_INGEST_TYPES);

export function miscRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireUser(ctx) };

  app.get('/api/health', async () => ({ ok: true }));

  app.get<{ Querystring: { limit?: string } }>('/api/feed', auth, async (req) =>
    feedFor(ctx, req.userId, Number(req.query.limit) || 30),
  );

  app.get('/api/sources', auth, async (req): Promise<SourcesResponse> => {
    const user = await getUser(ctx, req.userId);
    if (user.isDemo) return describeSources(ctx.cfg.SPARKY_PUBLIC_URL, []);
    const sources = await ctx.sparky.syncedSources(sparkyToken(ctx, user));
    return describeSources(ctx.cfg.SPARKY_PUBLIC_URL, sources);
  });

  /**
   * The Android app reads Health Connect and posts here; Gauntlet stores
   * nothing itself and forwards the records to SparkyFitness, tagged with
   * the same source the SparkyFitness app uses so re-syncs stay idempotent.
   */
  app.post('/api/ingest/health-connect', { ...auth, bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const { records } = ingestSchema.parse(req.body);
    const bad = records.find((r) => typeof r.type !== 'string' || !INGEST_TYPES.has(r.type));
    if (bad) throw badRequest(`Unsupported record type: ${String(bad.type)}`);
    const user = await getUser(ctx, req.userId);
    const token = sparkyToken(ctx, user);
    const result = await ctx.sparky.ingestHealthData(
      token,
      records.map((r) => ({ ...r, source: 'Health Connect' })),
    );
    // SparkyFitness only half-replaces a rescored night's stages: make the stored night match.
    // Extra care, so a failure here never fails the upload (the next sync tries again).
    await replaceSleep(ctx.sparky, token, sleepRecordsOf(records)).catch(() => 0);
    void syncUser(ctx, user.id).catch(() => undefined);
    return { forwarded: records.length, processed: result.processed, errors: result.errors.length };
  });

  /**
   * After every batch of a read went through, the phone lists the nights it sent for a range it read
   * in full. Health Connect entries in that range it didn't send were deleted there, so they go here
   * too. Without this call nothing is ever deleted.
   */
  app.post('/api/ingest/health-connect/sleep-days', auth, async (req) => {
    const days = sleepDaysSchema.parse(req.body);
    const user = await getUser(ctx, req.userId);
    return { removed: await removeMissingSleep(ctx.sparky, sparkyToken(ctx, user), days) };
  });
}
