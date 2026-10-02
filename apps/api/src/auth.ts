import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import type { AppContext } from './context.js';
import { HttpError } from './context.js';
import { randomToken, sha256 } from './crypto.js';
import { refreshTokens } from './db/schema.js';

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_DAYS = 60;
export const REFRESH_COOKIE = 'g_refresh';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

function key(ctx: AppContext) {
  return new TextEncoder().encode(ctx.cfg.JWT_SECRET);
}

export async function signAccessToken(ctx: AppContext, userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt(Math.floor(ctx.now().getTime() / 1000))
    .setExpirationTime(Math.floor(ctx.now().getTime() / 1000) + ACCESS_TTL_SECONDS)
    .setAudience('gauntlet')
    .sign(key(ctx));
}

export async function issueRefreshToken(ctx: AppContext, userId: string): Promise<string> {
  const token = randomToken(32);
  await ctx.db.insert(refreshTokens).values({
    userId,
    tokenHash: sha256(token),
    expiresAt: new Date(ctx.now().getTime() + REFRESH_TTL_DAYS * 86_400_000),
  });
  return token;
}

/** How long a rotated refresh token still works (a reload can drop the response with its successor). */
const ROTATION_GRACE_MS = 30_000;

/**
 * Exchange a refresh token for a new pair. The old token is retired (rotation), with a short grace
 * period so two quick page loads don't sign the person out.
 */
export async function rotateRefreshToken(
  ctx: AppContext,
  token: string,
): Promise<{ userId: string; refreshToken: string } | null> {
  const now = ctx.now();
  const [row] = await ctx.db
    .update(refreshTokens)
    .set({
      rotatedAt: sql`coalesce(${refreshTokens.rotatedAt}, ${now.toISOString()}::timestamptz)`,
    })
    .where(
      and(
        eq(refreshTokens.tokenHash, sha256(token)),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, now),
        or(
          isNull(refreshTokens.rotatedAt),
          gt(refreshTokens.rotatedAt, new Date(now.getTime() - ROTATION_GRACE_MS)),
        ),
      ),
    )
    .returning({ userId: refreshTokens.userId });
  if (!row) return null;
  return { userId: row.userId, refreshToken: await issueRefreshToken(ctx, row.userId) };
}

export async function revokeRefreshToken(ctx: AppContext, token: string) {
  await ctx.db
    .update(refreshTokens)
    .set({ revokedAt: ctx.now() })
    .where(eq(refreshTokens.tokenHash, sha256(token)));
}

export async function revokeAllRefreshTokens(ctx: AppContext, userId: string) {
  await ctx.db
    .update(refreshTokens)
    .set({ revokedAt: ctx.now() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

export function requireUser(ctx: AppContext) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new HttpError(401, 'Sign in required', 'unauthenticated');
    try {
      const { payload } = await jwtVerify(token, key(ctx), {
        audience: 'gauntlet',
        currentDate: ctx.now(),
      });
      if (!payload.sub) throw new Error('no subject');
      req.userId = payload.sub;
    } catch {
      throw new HttpError(401, 'Session expired', 'token_expired');
    }
  };
}

/** Native (Capacitor) clients keep the refresh token themselves; browsers get an httpOnly cookie. */
export function isNativeClient(req: FastifyRequest): boolean {
  return req.headers['x-gauntlet-client'] === 'native';
}
