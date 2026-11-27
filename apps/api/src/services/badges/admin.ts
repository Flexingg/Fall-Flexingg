/**
 * PLACEHOLDER (badge import branch): the badge engine branch provides the real version of this
 * file. Same signature; keep the engine's copy when merging.
 */
import type { AdminBadge, BadgeDraft } from '@gauntlet/shared';
import type { AppContext } from '../../context.js';
import { HttpError } from '../../context.js';
import { badgeDefinitions } from '../../db/schema.js';

export async function createDraftBadge(
  ctx: AppContext,
  draft: BadgeDraft,
  origin: 'admin' | 'garmin',
  sourceRef: string | null = null,
): Promise<AdminBadge> {
  const [row] = await ctx.db
    .insert(badgeDefinitions)
    .values({
      key: draft.key,
      name: draft.name,
      description: draft.description,
      family: draft.family,
      icon: draft.icon,
      imageUrl: draft.imageUrl,
      secret: draft.secret,
      rule: draft.rule,
      windowStart: draft.window?.start ?? null,
      windowEnd: draft.window?.end ?? null,
      xp: draft.xp,
      countsManual: draft.countsManual,
      status: 'draft',
      origin,
      sourceRef,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new HttpError(409, 'A badge with that key already exists', 'badge_key_taken');
  return {
    ...draft,
    status: 'draft',
    origin,
    sourceRef,
    version: row.version,
    earnedBy: 0,
    updatedAt: row.updatedAt.toISOString(),
    publishedAt: null,
  };
}
