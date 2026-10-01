import {
  connectBodySchema,
  isProviderId,
  oauthCallbackSchema,
  type ConnectionsResponse,
  type ConnectResult,
  type ProviderId,
} from '@gauntlet/shared';
import {
  completeOAuth,
  ConnectionError,
  connectProvider,
  disconnectProvider,
  listConnections,
  specFor,
  syncProvider,
  type ConnectionsEnv,
} from '@gauntlet/sparky';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../context.js';
import { syncUser } from '../services/sync.js';
import { getUser, sparkyToken } from '../services/users.js';

const FIRST_SYNC_DAYS = 30;
const REFRESH_SYNC_DAYS = 7;

/**
 * Link apps and devices (Strava, Fitbit, Oura, Polar, COROS, Hevy, Liftosaur, wger; Garmin has its
 * own sign-in form in routes/garmin.ts) through SparkyFitness, with the person's own key.
 */
export function connectionRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireUser(ctx) };
  const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: '10 minutes' } } });

  const env = (): ConnectionsEnv => ({
    sparkyUrl: ctx.cfg.SPARKY_PUBLIC_URL,
    oauthAvailable: true,
    oauth: ctx.cfg.oauthApps,
    now: ctx.now,
  });
  const tokenFor = async (userId: string) => sparkyToken(ctx, await getUser(ctx, userId));

  const providerId = (raw: string): ProviderId => {
    if (!isProviderId(raw)) throw new HttpError(404, 'Unknown app', 'not_found');
    return raw;
  };

  /** ConnectionError -> an HTTP answer a person can read. Anything else is for the global handler. */
  async function run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ConnectionError) throw new HttpError(err.status, err.message, err.code);
      throw err;
    }
  }

  /** Pull the provider's data into SparkyFitness, then into standings. Never blocks the caller. */
  function syncInBackground(userId: string, token: string, id: ProviderId, days: number) {
    void syncProvider(ctx.sparky, token, id, days, ctx.now())
      .catch((err) => ctx.log.warn({ err: String(err), id }, 'provider sync failed'))
      .then(() => syncUser(ctx, userId))
      .catch((err) => ctx.log.warn({ err: String(err), id }, 'sync after provider failed'));
  }

  app.get('/api/connections', auth, async (req): Promise<ConnectionsResponse> => {
    const token = await tokenFor(req.userId);
    return { connections: await run(() => listConnections(ctx.sparky, token, env())) };
  });

  app.post<{ Params: { id: string } }>(
    '/api/connections/:id/connect',
    { ...auth, ...limit(20) },
    async (req): Promise<ConnectResult> => {
      const id = providerId(req.params.id);
      const body = connectBodySchema.parse(req.body ?? {});
      const token = await tokenFor(req.userId);
      const result = await run(() => connectProvider(ctx.sparky, token, id, env(), body));
      if (result.status === 'connected' && specFor(id).kind === 'api_key')
        syncInBackground(req.userId, token, id, FIRST_SYNC_DAYS);
      return result;
    },
  );

  /** The provider sent the person back with a code. */
  app.post<{ Params: { id: string } }>(
    '/api/connections/:id/oauth',
    { ...auth, ...limit(20) },
    async (req) => {
      const id = providerId(req.params.id);
      const body = oauthCallbackSchema.parse(req.body);
      const token = await tokenFor(req.userId);
      await run(() => completeOAuth(ctx.sparky, token, id, body));
      syncInBackground(req.userId, token, id, FIRST_SYNC_DAYS);
      return { status: 'connected' } satisfies ConnectResult;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/connections/:id/sync',
    { ...auth, ...limit(30) },
    async (req) => {
      const id = providerId(req.params.id);
      const token = await tokenFor(req.userId);
      const all = await run(() => listConnections(ctx.sparky, token, env()));
      if (all.find((c) => c.id === id)?.state !== 'connected')
        throw new HttpError(400, `${specFor(id).label} is not connected.`, 'not_connected');
      syncInBackground(req.userId, token, id, REFRESH_SYNC_DAYS);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/connections/:id/disconnect',
    { ...auth, ...limit(20) },
    async (req) => {
      const id = providerId(req.params.id);
      const token = await tokenFor(req.userId);
      await run(() => disconnectProvider(ctx.sparky, token, id));
      return { ok: true };
    },
  );
}
