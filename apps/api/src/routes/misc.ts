import { ingestSchema, type SourcesResponse } from '@gauntlet/shared';
import { describeSources } from '@gauntlet/sparky';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest } from '../context.js';
import { feedFor } from '../services/feed.js';
import { syncUser } from '../services/sync.js';
import { getUser, sparkyToken } from '../services/users.js';

/** Record types the Android app may forward from Health Connect. */
const INGEST_TYPES = new Set([
  'step',
  'steps',
  'distance',
  'Active Calories',
  'active_calories',
  'resting_heart_rate',
  'weight',
  'SleepSession',
  'ExerciseSession',
]);

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
    const result = await ctx.sparky.ingestHealthData(
      sparkyToken(ctx, user),
      records.map((r) => ({ ...r, source: 'Health Connect' })),
    );
    void syncUser(ctx, user.id).catch(() => undefined);
    return { forwarded: records.length, processed: result.processed, errors: result.errors.length };
  });
}
