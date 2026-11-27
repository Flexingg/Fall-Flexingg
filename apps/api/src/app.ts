import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { legalRoutes } from './routes/legal.js';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { AppContext } from './context.js';
import { HttpError } from './context.js';
import { downloadRoutes } from './downloads.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { challengeRoutes } from './routes/challenges.js';
import { teamRoutes } from './routes/teams.js';
import { stakeRoutes } from './routes/stakes.js';
import { connectionRoutes } from './routes/connections.js';
import { garminRoutes } from './routes/garmin.js';
import { friendRoutes } from './routes/friends.js';
import { userRoutes } from './routes/users.js';
import { inviteRoutes } from './routes/invites.js';
import { meRoutes } from './routes/me.js';
import { statsRoutes } from './routes/stats.js';
import { miscRoutes } from './routes/misc.js';
import { socialRoutes } from './routes/social.js';
import { notificationRoutes } from './routes/notifications.js';
import { pushRoutes } from './routes/push.js';
import { reviewRoutes } from './routes/review.js';
import { badgeSuggestionRoutes } from './routes/badgeSuggestions.js';
import { registerPushDelivery } from './services/push.js';
import { SparkyError } from '@gauntlet/sparky';
import { markKeyInvalid } from './services/users.js';

export async function buildApp(
  ctx: Omit<AppContext, 'log'>,
  opts: { logger?: boolean | object } = {},
): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });
  const full: AppContext = { ...ctx, log: app.log };

  // Android's native HTTP (CapacitorHttp) gives requests without a body, such as DELETE, a form
  // content type. Accept it (as fields, or no body) instead of answering 415; routes still validate
  // whatever they need.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) =>
      done(null, body ? Object.fromEntries(new URLSearchParams(body as string)) : undefined),
  );

  await app.register(cookie);
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || full.cfg.allowedOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Timezone', 'X-Gauntlet-Client'],
  });
  await app.register(rateLimit, {
    global: true,
    max: full.cfg.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.code(400).send({
        error: first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid request',
        code: 'validation',
      });
    }
    if (err instanceof HttpError)
      return reply.code(err.status).send({ error: err.message, code: err.code });
    if (err instanceof SparkyError) {
      if (err.status === 401 && req.userId) {
        void markKeyInvalid(full, req.userId);
        return reply.code(409).send({
          error: 'Your SparkyFitness connection expired. Sign in again.',
          code: 'sparky_key_invalid',
        });
      }
      req.log.warn({ err }, 'sparky error');
      return reply
        .code(502)
        .send({ error: `SparkyFitness: ${err.message}`, code: 'sparky_unavailable' });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500)
      return reply.code(e.statusCode).send({ error: e.message, code: 'request' });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'Something went wrong', code: 'internal' });
  });

  authRoutes(app, full);
  adminRoutes(app, full);
  meRoutes(app, full);
  statsRoutes(app, full);
  friendRoutes(app, full);
  userRoutes(app, full);
  inviteRoutes(app, full);
  challengeRoutes(app, full);
  teamRoutes(app, full);
  stakeRoutes(app, full);
  miscRoutes(app, full);
  socialRoutes(app, full);
  garminRoutes(app, full);
  connectionRoutes(app, full);
  notificationRoutes(app, full);
  pushRoutes(app, full);
  reviewRoutes(app, full);
  badgeSuggestionRoutes(app, full);
  registerPushDelivery();
  downloadRoutes(app, full.cfg);
  legalRoutes(app, full);

  if (full.cfg.WEB_DIST) await serveWeb(app, full.cfg.WEB_DIST);

  return { app, ctx: full };
}

/** Serve the built PWA, with index.html as the fallback for client-side routes. */
async function serveWeb(app: FastifyInstance, root: string) {
  await app.register(fastifyStatic, {
    root,
    wildcard: false,
    cacheControl: false,
    setHeaders(res, path) {
      // Hashed build assets never change; the shell and service worker must revalidate.
      if (/[\\/]assets[\\/]/.test(path))
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control', 'no-cache');
    },
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found', code: 'not_found' });
    }
    reply.header('Cache-Control', 'no-cache');
    return reply.sendFile('index.html');
  });
}
