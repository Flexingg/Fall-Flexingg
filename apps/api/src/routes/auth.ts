import { loginSchema, signupSchema, twoFactorSchema, type LoginResponse } from '@gauntlet/shared';
import { eq, lt } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  isNativeClient,
  issueRefreshToken,
  REFRESH_COOKIE,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
} from '../auth.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../context.js';
import { decrypt, encrypt, randomToken, sha256 } from '../crypto.js';
import { pendingLogins } from '../db/schema.js';
import { SparkyError, type SparkyUser } from '@gauntlet/sparky';
import { findDemoUser, refreshDemo } from '../services/demo.js';
import { syncUser } from '../services/sync.js';
import { toMe, upsertFromSparky } from '../services/users.js';

const TWO_FACTOR_TTL_MS = 5 * 60_000;

export function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const loginLimit = {
    config: { rateLimit: { max: ctx.cfg.LOGIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
  };

  app.post('/api/auth/login', loginLimit, async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const tz = timezoneHeader(req);
    if (body.method === 'api_key') {
      let sparkyUser: SparkyUser;
      try {
        sparkyUser = await ctx.sparky.currentUser(body.apiKey);
      } catch (err) {
        throw toAuthError(err, 'That API key was not accepted by SparkyFitness.');
      }
      return finishLogin(ctx, req, reply, sparkyUser, { apiKey: body.apiKey, keyId: null }, tz);
    }

    let result;
    try {
      result = await ctx.sparky.signIn(body.email, body.password, clientIp(req));
    } catch (err) {
      throw toAuthError(err, 'Email or password is incorrect.');
    }
    if (result.kind === 'two_factor') {
      const ticket = randomToken(24);
      await ctx.db.delete(pendingLogins).where(lt(pendingLogins.expiresAt, ctx.now()));
      await ctx.db.insert(pendingLogins).values({
        ticketHash: sha256(ticket),
        cookieEnc: encrypt(result.cookie, ctx.cfg.encryptionKey),
        expiresAt: new Date(ctx.now().getTime() + TWO_FACTOR_TTL_MS),
      });
      return { status: 'two_factor', ticket } satisfies LoginResponse;
    }
    return mintAndFinish(ctx, req, reply, result.token, result.user, tz);
  });

  /** Create a SparkyFitness account and sign in to Gauntlet with it, in one step. */
  app.post(
    '/api/auth/signup',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const body = signupSchema.parse(req.body);
      let created;
      try {
        created = await ctx.sparky.signUp(body, clientIp(req));
      } catch (err) {
        throw toSignupError(err);
      }
      return mintAndFinish(ctx, req, reply, created.token, created.user, timezoneHeader(req));
    },
  );

  /** Sign in as the built-in demo account: sample data, no SparkyFitness account needed. */
  app.post(
    '/api/auth/demo',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      if (!ctx.cfg.DEMO_ACCOUNT) throw new HttpError(404, 'The demo is switched off', 'demo_off');
      let user = await findDemoUser(ctx);
      if (!user) {
        await refreshDemo(ctx);
        user = await findDemoUser(ctx);
      }
      if (!user)
        throw new HttpError(
          503,
          'The demo is not ready yet. Try again in a moment.',
          'demo_unavailable',
        );
      const refreshToken = await issueRefreshToken(ctx, user.id);
      const tokens = await respondWithTokens(ctx, req, reply, user.id, refreshToken);
      return { status: 'ok', ...tokens, user: toMe(user, ctx) } satisfies LoginResponse;
    },
  );

  app.post('/api/auth/login/2fa', loginLimit, async (req, reply) => {
    const body = twoFactorSchema.parse(req.body);
    const [pending] = await ctx.db
      .select()
      .from(pendingLogins)
      .where(eq(pendingLogins.ticketHash, sha256(body.ticket)));
    if (!pending || pending.expiresAt < ctx.now())
      throw new HttpError(401, 'That sign-in attempt expired. Start again.', 'ticket_expired');
    let verified;
    try {
      verified = await ctx.sparky.verifyTwoFactor(
        decrypt(pending.cookieEnc, ctx.cfg.encryptionKey),
        body.code,
        body.method,
        clientIp(req),
      );
    } catch (err) {
      throw toAuthError(err, 'That code did not work.');
    }
    await ctx.db.delete(pendingLogins).where(eq(pendingLogins.ticketHash, pending.ticketHash));
    return mintAndFinish(ctx, req, reply, verified.token, verified.user, timezoneHeader(req));
  });

  app.post('/api/auth/refresh', async (req, reply) => {
    const token = refreshTokenFrom(req);
    if (!token) throw new HttpError(401, 'Sign in required', 'unauthenticated');
    const rotated = await rotateRefreshToken(ctx, token);
    if (!rotated) {
      clearRefreshCookie(reply);
      throw new HttpError(401, 'Session expired', 'refresh_invalid');
    }
    return respondWithTokens(ctx, req, reply, rotated.userId, rotated.refreshToken);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = refreshTokenFrom(req);
    if (token) await revokeRefreshToken(ctx, token);
    clearRefreshCookie(reply);
    return { ok: true };
  });
}

/** Turn a SparkyFitness session into a long-lived API key that Gauntlet keeps (encrypted). */
async function mintAndFinish(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  sessionToken: string,
  sparkyUser: SparkyUser,
  tz: string | undefined,
) {
  let key: { id: string; key: string };
  try {
    key = await ctx.sparky.createApiKey(sessionToken, ctx.cfg.SPARKY_KEY_NAME);
  } catch (err) {
    throw toAuthError(err, 'SparkyFitness would not create an access key for Gauntlet.');
  }
  const res = await finishLogin(
    ctx,
    req,
    reply,
    sparkyUser,
    { apiKey: key.key, keyId: key.id },
    tz,
    sessionToken,
  );
  void ctx.sparky.signOut(sessionToken);
  return res;
}

async function finishLogin(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  sparkyUser: SparkyUser,
  key: { apiKey: string; keyId: string | null },
  tz: string | undefined,
  sessionToken?: string,
) {
  const { user, previousKeyId } = await upsertFromSparky(
    ctx,
    sparkyUser,
    key.apiKey,
    key.keyId,
    tz,
  );
  // Clean up the key from the previous login so keys don't pile up in SparkyFitness.
  if (previousKeyId && sessionToken && previousKeyId !== key.keyId) {
    ctx.sparky
      .deleteApiKey(sessionToken, previousKeyId)
      .catch((err) => ctx.log.debug({ err }, 'old key cleanup failed'));
  }
  // Start pulling data in the background; the app shows it as it arrives.
  void syncUser(ctx, user.id).catch((err) => ctx.log.warn({ err }, 'initial sync failed'));
  const refreshToken = await issueRefreshToken(ctx, user.id);
  const tokens = await respondWithTokens(ctx, req, reply, user.id, refreshToken);
  return { status: 'ok', ...tokens, user: toMe(user, ctx) } satisfies LoginResponse;
}

async function respondWithTokens(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  refreshToken: string,
) {
  const accessToken = await signAccessToken(ctx, userId);
  if (isNativeClient(req)) return { accessToken, refreshToken };
  reply.setCookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure: req.protocol === 'https' || ctx.cfg.PUBLIC_WEB_URL.startsWith('https'),
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: 60 * 60 * 24 * 60,
  });
  return { accessToken };
}

function refreshTokenFrom(req: FastifyRequest): string | null {
  const body = (req.body ?? {}) as { refreshToken?: unknown };
  if (typeof body.refreshToken === 'string' && body.refreshToken) return body.refreshToken;
  return req.cookies[REFRESH_COOKIE] ?? null;
}

function clearRefreshCookie(reply: FastifyReply) {
  reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
}

function timezoneHeader(req: FastifyRequest): string | undefined {
  const tz = req.headers['x-timezone'];
  return typeof tz === 'string' ? tz : undefined;
}

/**
 * The person's own address, passed to SparkyFitness so its sign-in limits count per person.
 * Fly's proxy sets Fly-Client-IP; elsewhere Fastify's req.ip (trustProxy) is used.
 */
function clientIp(req: FastifyRequest): string | undefined {
  const fly = req.headers['fly-client-ip'];
  if (typeof fly === 'string' && fly) return fly;
  return req.ip || undefined;
}

function toSignupError(err: unknown): HttpError {
  if (err instanceof SparkyError) {
    const code = (err.body as { code?: string } | null)?.code ?? '';
    if (code.startsWith('USER_ALREADY_EXISTS') || err.status === 422)
      return new HttpError(
        409,
        'There is already an account with that email. Sign in instead.',
        'email_taken',
      );
    if (code === 'PASSWORD_TOO_SHORT')
      return new HttpError(400, 'Use at least 8 characters for your password.', 'weak_password');
    if (code === 'PASSWORD_TOO_LONG')
      return new HttpError(400, 'That password is too long.', 'weak_password');
    if (/signups? (are|is) (currently )?disabled/i.test(err.message))
      return new HttpError(403, 'New accounts are switched off on this server.', 'signup_disabled');
  }
  return toAuthError(err, 'Could not create the account.');
}

function toAuthError(err: unknown, fallback: string): HttpError {
  if (err instanceof SparkyError) {
    if (err.status === 401 || err.status === 403 || err.status === 400)
      return new HttpError(401, err.message || fallback, 'sparky_auth');
    if (err.status === 429)
      return new HttpError(429, 'Too many attempts. Wait a minute and try again.', 'rate_limited');
    return new HttpError(502, `SparkyFitness is unavailable: ${err.message}`, 'sparky_unavailable');
  }
  throw err;
}
