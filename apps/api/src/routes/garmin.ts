import {
  addDays,
  garminLoginSchema,
  garminMfaSchema,
  todayIn,
  type GarminLoginResult,
  type GarminStatus,
} from '@gauntlet/shared';
import { describeGarminError } from '@gauntlet/sparky';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../context.js';
import { syncUser } from '../services/sync.js';
import { getUser, sparkyToken } from '../services/users.js';

/** Days of Garmin history pulled right after connecting; later syncs only need recent days. */
const FIRST_SYNC_DAYS = 30;
const REFRESH_SYNC_DAYS = 7;

/**
 * Connect Garmin Connect from inside the app. SparkyFitness does all the work (it signs in to
 * Garmin, keeps the session and stores the data); these routes pass the request along with the
 * person's own API key. The Garmin password is forwarded once and never stored or logged here.
 */
export function garminRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireUser(ctx) };
  const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: '10 minutes' } } });

  const tokenFor = async (userId: string) => sparkyToken(ctx, await getUser(ctx, userId));

  /** A SparkyFitness failure, in words a person can act on. */
  function fail(err: unknown): never {
    const problem = describeGarminError(err);
    if (problem) throw new HttpError(problem.status, problem.message, problem.code);
    throw err;
  }

  /** Pull Garmin's data into SparkyFitness, then into Gauntlet's standings. Never blocks the caller. */
  function syncInBackground(userId: string, token: string, days: number) {
    const today = todayIn('UTC', ctx.now());
    void ctx.sparky
      .garminSync(token, addDays(today, -days), today)
      .catch((err) => ctx.log.warn({ err: String(err) }, 'garmin sync failed'))
      .then(() => syncUser(ctx, userId))
      .catch((err) => ctx.log.warn({ err: String(err) }, 'sync after garmin failed'));
  }

  app.get('/api/garmin', auth, async (req): Promise<GarminStatus> => {
    try {
      return await ctx.sparky.garminStatus(await tokenFor(req.userId));
    } catch (err) {
      return fail(err);
    }
  });

  app.post(
    '/api/garmin/login',
    { ...auth, ...limit(10) },
    async (req): Promise<GarminLoginResult> => {
      const body = garminLoginSchema.parse(req.body);
      const token = await tokenFor(req.userId);
      try {
        const result = await ctx.sparky.garminLogin(token, body.email, body.password);
        if (result.status === 'connected') syncInBackground(req.userId, token, FIRST_SYNC_DAYS);
        return result;
      } catch (err) {
        return fail(err);
      }
    },
  );

  app.post(
    '/api/garmin/login/mfa',
    { ...auth, ...limit(20) },
    async (req): Promise<GarminLoginResult> => {
      const body = garminMfaSchema.parse(req.body);
      const token = await tokenFor(req.userId);
      try {
        const result = await ctx.sparky.garminResumeLogin(token, body.clientState, body.code);
        if (result.status === 'connected') syncInBackground(req.userId, token, FIRST_SYNC_DAYS);
        return result;
      } catch (err) {
        return fail(err);
      }
    },
  );

  /** "Sync now": starts a sync and returns; Today and standings pick the data up as it lands. */
  app.post('/api/garmin/sync', { ...auth, ...limit(12) }, async (req) => {
    const token = await tokenFor(req.userId);
    try {
      const status = await ctx.sparky.garminStatus(token);
      if (!status.linked) throw new HttpError(400, 'Garmin is not connected.', 'garmin_not_linked');
    } catch (err) {
      if (err instanceof HttpError) throw err;
      return fail(err);
    }
    syncInBackground(req.userId, token, REFRESH_SYNC_DAYS);
    return { ok: true };
  });

  app.post('/api/garmin/disconnect', { ...auth, ...limit(10) }, async (req) => {
    try {
      await ctx.sparky.garminUnlink(await tokenFor(req.userId));
    } catch (err) {
      return fail(err);
    }
    return { ok: true };
  });
}
