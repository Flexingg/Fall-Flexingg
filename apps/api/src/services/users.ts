import type { MeUser, PublicUser } from '@gauntlet/shared';
import { eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { HttpError, notFound } from '../context.js';
import { decrypt, encrypt } from '../crypto.js';
import { users } from '../db/schema.js';
import type { SparkyUser } from '../sparky/client.js';

export type UserRow = typeof users.$inferSelect;

export function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? `${parts[0]![0]}${parts[parts.length - 1]![0]}` : (parts[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

/** "Maya Rodriguez" -> "Maya R." for leaderboards. */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? name;
  return `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.`;
}

export function toPublicUser(u: Pick<UserRow, 'id' | 'displayName'>): PublicUser {
  return { id: u.id, displayName: u.displayName, initials: initials(u.displayName) };
}

export function toMe(u: UserRow): MeUser {
  return {
    ...toPublicUser(u),
    email: u.email,
    timezone: u.timezone,
    settings: { shareWorkoutDetails: u.shareWorkoutDetails, healthConnectSync: u.healthConnectSync },
    sparkyKeyStatus: u.keyStatus,
  };
}

export async function getUser(ctx: AppContext, id: string): Promise<UserRow> {
  const [u] = await ctx.db.select().from(users).where(eq(users.id, id));
  if (!u) throw notFound('User not found');
  return u;
}

export async function getUsers(ctx: AppContext, ids: string[]): Promise<Map<string, UserRow>> {
  if (!ids.length) return new Map();
  const rows = await ctx.db.select().from(users).where(inArray(users.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r]));
}

/** The user's SparkyFitness API key, decrypted. */
export function sparkyToken(ctx: AppContext, u: UserRow): string {
  if (!u.sparkyKeyEnc || u.keyStatus !== 'active') {
    throw new HttpError(409, 'Your SparkyFitness connection expired. Sign in again.', 'sparky_key_invalid');
  }
  return decrypt(u.sparkyKeyEnc, ctx.cfg.encryptionKey);
}

export async function markKeyInvalid(ctx: AppContext, userId: string) {
  await ctx.db.update(users).set({ keyStatus: 'invalid' }).where(eq(users.id, userId));
}

function defaultName(s: SparkyUser): string {
  if (s.name?.trim()) return s.name.trim().slice(0, 40);
  const local = s.email.split('@')[0] ?? 'Athlete';
  return local.charAt(0).toUpperCase() + local.slice(1, 40);
}

/** Create or update the Gauntlet user for a SparkyFitness account, storing its new API key. */
export async function upsertFromSparky(
  ctx: AppContext,
  s: SparkyUser,
  apiKey: string,
  keyId: string | null,
  timezone?: string,
): Promise<{ user: UserRow; previousKeyId: string | null }> {
  const [existing] = await ctx.db.select().from(users).where(eq(users.sparkyUserId, s.id));
  const sparkyKeyEnc = encrypt(apiKey, ctx.cfg.encryptionKey);
  if (existing) {
    const [user] = await ctx.db
      .update(users)
      .set({ email: s.email || existing.email, sparkyKeyEnc, sparkyKeyId: keyId, keyStatus: 'active' })
      .where(eq(users.id, existing.id))
      .returning();
    return { user: user!, previousKeyId: existing.sparkyKeyId };
  }
  const [user] = await ctx.db
    .insert(users)
    .values({
      sparkyUserId: s.id,
      email: s.email,
      displayName: defaultName(s),
      timezone: timezone && isValidTimeZone(timezone) ? timezone : 'UTC',
      sparkyKeyEnc,
      sparkyKeyId: keyId,
    })
    .returning();
  return { user: user!, previousKeyId: null };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
