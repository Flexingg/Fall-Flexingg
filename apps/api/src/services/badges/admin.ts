/**
 * Managing badge definitions: create (also used by the Garmin import's "approve suggestion"), edit,
 * publish, retire, delete drafts, and uploaded images. Rules are validated with the shared schemas
 * on the way in; nothing is ever executed from them.
 *
 * Lifecycle: draft -> live -> retired. Editing a live badge's rule or window bumps its version and
 * re-runs the backfill; people keep everything they already earned (rows are never removed).
 */
import {
  badgeDraftSchema,
  type AdminBadge,
  type BadgeDraft,
  type BadgeOrigin,
} from '@gauntlet/shared';
import { and, count, eq, max, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { badRequest, HttpError, notFound } from '../../context.js';
import { badgeDefinitions, badgeImages, userBadges, users } from '../../db/schema.js';
import { stableJson, type DefinitionRow } from './engine.js';
import { enqueueBackfill } from './publishAll.js';

const IMAGE_URL_PREFIX = '/api/badge-images/';

function toAdminBadge(d: DefinitionRow, earnedBy: number): AdminBadge {
  return {
    key: d.key,
    name: d.name,
    description: d.description,
    family: d.family as AdminBadge['family'],
    icon: d.icon as AdminBadge['icon'],
    imageUrl: d.imageUrl,
    secret: d.secret,
    rule: d.rule,
    window: d.windowStart && d.windowEnd ? { start: d.windowStart, end: d.windowEnd } : null,
    xp: d.xp ?? null,
    countsManual: d.countsManual,
    status: d.status,
    origin: d.origin,
    sourceRef: d.sourceRef,
    version: d.version,
    earnedBy,
    updatedAt: d.updatedAt.toISOString(),
    publishedAt: d.publishedAt?.toISOString() ?? null,
  };
}

async function earnedCounts(ctx: AppContext): Promise<Map<string, number>> {
  const rows = await ctx.db
    .select({ key: userBadges.badgeKey, n: sql<number>`count(distinct ${userBadges.userId})::int` })
    .from(userBadges)
    .innerJoin(users, eq(users.id, userBadges.userId))
    .where(eq(users.isDemo, false))
    .groupBy(userBadges.badgeKey);
  return new Map(rows.map((r) => [r.key, r.n]));
}

export async function listAdminBadges(ctx: AppContext): Promise<AdminBadge[]> {
  const [defs, counts] = await Promise.all([
    ctx.db.select().from(badgeDefinitions),
    earnedCounts(ctx),
  ]);
  return defs
    .sort(
      (a, b) =>
        a.family.localeCompare(b.family) || a.position - b.position || a.name.localeCompare(b.name),
    )
    .map((d) => toAdminBadge(d, counts.get(d.key) ?? 0));
}

export async function getAdminBadge(ctx: AppContext, key: string): Promise<AdminBadge> {
  const d = await getDefinition(ctx, key);
  return toAdminBadge(d, (await earnedCounts(ctx)).get(key) ?? 0);
}

async function getDefinition(ctx: AppContext, key: string): Promise<DefinitionRow> {
  const [d] = await ctx.db.select().from(badgeDefinitions).where(eq(badgeDefinitions.key, key));
  if (!d) throw notFound('Badge not found');
  return d;
}

/** Re-validate a draft (callers may hand in unparsed data) and refuse foreign image links. */
function checkDraft(raw: BadgeDraft): BadgeDraft {
  const parsed = badgeDraftSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw badRequest(
      first ? `${first.path.join('.') || 'badge'}: ${first.message}` : 'Invalid badge',
      'validation',
    );
  }
  const d = parsed.data;
  if (d.imageUrl && !/^\/api\/badge-images\/[0-9a-f-]{36}$/i.test(d.imageUrl))
    throw badRequest('Use an image uploaded through the badge editor.', 'bad_image');
  if (d.window && d.window.end < d.window.start)
    throw badRequest('The window ends before it starts.', 'bad_window');
  return d;
}

const columns = (d: BadgeDraft) => ({
  name: d.name,
  description: d.description,
  family: d.family,
  icon: d.icon,
  imageUrl: d.imageUrl,
  secret: d.secret,
  rule: d.rule,
  windowStart: d.window?.start ?? null,
  windowEnd: d.window?.end ?? null,
  xp: d.xp,
  countsManual: d.countsManual,
});

/** Create a draft badge. Throws 409 when the key is taken. */
export async function createDraftBadge(
  ctx: AppContext,
  draft: BadgeDraft,
  origin: 'admin' | 'garmin',
  sourceRef: string | null = null,
): Promise<AdminBadge> {
  const d = checkDraft(draft);
  const [exists] = await ctx.db
    .select({ key: badgeDefinitions.key })
    .from(badgeDefinitions)
    .where(eq(badgeDefinitions.key, d.key));
  if (exists) throw new HttpError(409, 'A badge with that key already exists.', 'badge_exists');
  const [top] = await ctx.db
    .select({ p: max(badgeDefinitions.position) })
    .from(badgeDefinitions)
    .where(eq(badgeDefinitions.family, d.family));
  const [row] = await ctx.db
    .insert(badgeDefinitions)
    .values({
      key: d.key,
      ...columns(d),
      status: 'draft',
      origin: origin satisfies BadgeOrigin,
      sourceRef,
      position: (top?.p ?? -1) + 1,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new HttpError(409, 'A badge with that key already exists.', 'badge_exists');
  return toAdminBadge(row, 0);
}

/** Edit a badge (its key never changes). A live badge whose rule or window changes is re-backfilled. */
export async function updateBadge(
  ctx: AppContext,
  key: string,
  draft: BadgeDraft,
): Promise<AdminBadge> {
  const cur = await getDefinition(ctx, key);
  const d = checkDraft({ ...draft, key });
  const ruleChanged =
    stableJson(cur.rule) !== stableJson(d.rule) ||
    (cur.windowStart ?? null) !== (d.window?.start ?? null) ||
    (cur.windowEnd ?? null) !== (d.window?.end ?? null) ||
    cur.countsManual !== d.countsManual;
  const bump = cur.status === 'live' && ruleChanged;
  const [row] = await ctx.db
    .update(badgeDefinitions)
    .set({
      ...columns(d),
      version: bump ? cur.version + 1 : cur.version,
      customized: cur.origin === 'builtin' ? true : cur.customized,
      updatedAt: ctx.now(),
    })
    .where(eq(badgeDefinitions.key, key))
    .returning();
  if (bump) await enqueueBackfill(ctx, [key]);
  return toAdminBadge(row!, (await earnedCounts(ctx)).get(key) ?? 0);
}

/** draft (or retired) -> live. Everyone who already qualifies gets it quietly in the background. */
export async function publishBadge(ctx: AppContext, key: string): Promise<AdminBadge> {
  const cur = await getDefinition(ctx, key);
  if (cur.status === 'live')
    throw new HttpError(409, 'That badge is already live.', 'already_live');
  const [row] = await ctx.db
    .update(badgeDefinitions)
    .set({ status: 'live', publishedAt: ctx.now(), retiredAt: null, updatedAt: ctx.now() })
    .where(eq(badgeDefinitions.key, key))
    .returning();
  await enqueueBackfill(ctx, [key]);
  return toAdminBadge(row!, (await earnedCounts(ctx)).get(key) ?? 0);
}

/** Stop awarding a badge. Everyone who earned it keeps it (and its XP). */
export async function retireBadge(ctx: AppContext, key: string): Promise<AdminBadge> {
  const cur = await getDefinition(ctx, key);
  if (cur.status !== 'live')
    throw new HttpError(409, 'Only a live badge can be retired.', 'not_live');
  const [row] = await ctx.db
    .update(badgeDefinitions)
    .set({
      status: 'retired',
      retiredAt: ctx.now(),
      updatedAt: ctx.now(),
      // The startup seed must not bring back a built-in an admin retired.
      customized: cur.origin === 'builtin' ? true : cur.customized,
    })
    .where(eq(badgeDefinitions.key, key))
    .returning();
  return toAdminBadge(row!, (await earnedCounts(ctx)).get(key) ?? 0);
}

export async function deleteDraftBadge(ctx: AppContext, key: string): Promise<void> {
  const cur = await getDefinition(ctx, key);
  if (cur.status !== 'draft')
    throw new HttpError(
      409,
      'Only a draft can be deleted. Retire a live badge instead.',
      'not_draft',
    );
  const [{ n } = { n: 0 }] = await ctx.db
    .select({ n: count() })
    .from(userBadges)
    .where(eq(userBadges.badgeKey, key));
  if (n)
    throw new HttpError(
      409,
      'Someone already earned this badge, so it cannot be deleted.',
      'has_earners',
    );
  await ctx.db
    .delete(badgeDefinitions)
    .where(and(eq(badgeDefinitions.key, key), eq(badgeDefinitions.status, 'draft')));
}

// ---------- Images ----------

export const IMAGE_MAX_BYTES = 256 * 1024;
export const IMAGE_MIMES = ['image/png', 'image/webp', 'image/svg+xml', 'image/jpeg'] as const;

/** Throws unless the bytes really are the claimed image type and (for SVG) carry no script. */
export function validateImage(mime: string, data: Buffer): void {
  if (!(IMAGE_MIMES as readonly string[]).includes(mime))
    throw badRequest('Use a PNG, WebP, JPEG or SVG image.', 'bad_image');
  if (!data.length) throw badRequest('That image is empty.', 'bad_image');
  if (data.length > IMAGE_MAX_BYTES)
    throw badRequest('Images can be at most 256 KB.', 'image_too_big');
  const starts = (...sig: number[]) => sig.every((b, i) => data[i] === b);
  if (mime === 'image/png' && !starts(0x89, 0x50, 0x4e, 0x47))
    throw badRequest('That is not a PNG.', 'bad_image');
  if (mime === 'image/jpeg' && !starts(0xff, 0xd8, 0xff))
    throw badRequest('That is not a JPEG.', 'bad_image');
  if (
    mime === 'image/webp' &&
    !(data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP')
  )
    throw badRequest('That is not a WebP.', 'bad_image');
  if (mime === 'image/svg+xml') {
    const text = data.toString('utf8');
    if (!/<svg[\s>]/i.test(text)) throw badRequest('That is not an SVG.', 'bad_image');
    if (
      /<script/i.test(text) ||
      /\bon\w+\s*=/i.test(text) ||
      /javascript:/i.test(text) ||
      /<foreignobject/i.test(text) ||
      /<(iframe|embed|object)/i.test(text) ||
      /<!entity/i.test(text) ||
      /(href|src)\s*=\s*["']?\s*(https?:|\/\/|data:text)/i.test(text)
    )
      throw badRequest(
        'That SVG has scripts or outside links in it, which is not allowed.',
        'unsafe_svg',
      );
  }
}

export async function saveImage(
  ctx: AppContext,
  mime: string,
  data: Buffer,
): Promise<{ url: string }> {
  validateImage(mime, data);
  const [row] = await ctx.db
    .insert(badgeImages)
    .values({ mime, data, createdAt: ctx.now() })
    .returning({ id: badgeImages.id });
  return { url: `${IMAGE_URL_PREFIX}${row!.id}` };
}

export async function loadImage(ctx: AppContext, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await ctx.db.select().from(badgeImages).where(eq(badgeImages.id, id));
  return row ?? null;
}
