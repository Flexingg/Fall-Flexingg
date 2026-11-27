/**
 * What people see: badge definitions + a person's earned rows turned into BadgeView / catalog /
 * detail responses, worded in the viewer's own units ("Cover 100 km" reads "Cover 62 mi" for
 * someone on imperial). Rules about who sees what live here:
 *  - drafts are never shown; retired badges only to people who earned them;
 *  - a limited-time badge is hidden before it starts and, unearned, after it ends;
 *  - an unearned secret badge is "?" with no detail.
 * Progress toward the next tier is only worked out for your own catalog (it costs a query per badge).
 */
import {
  BADGE_FAMILIES,
  formatFlexible,
  formatInt,
  formatQuantityFlexible,
  levelFor,
  metricDef,
  ruleTiers,
  tierName,
  todayIn,
  xpForTier,
  type BadgeCatalogResponse,
  type BadgeDetailResponse,
  type BadgeFamily,
  type BadgeIcon,
  type BadgeRule,
  type BadgeTierView,
  type BadgeView,
  type DisplayPrefs,
  type MetricKey,
  type UnseenBadgesResponse,
} from '@gauntlet/shared';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { HttpError, notFound } from '../../context.js';
import {
  badgeDefinitions,
  challengeParticipants,
  challenges,
  userBadges,
  users,
} from '../../db/schema.js';
import { displayFor } from '../display.js';
import { friendIds } from '../friends.js';
import { getUser, toPublicUser } from '../users.js';
import { evalDefOf, type DefinitionRow } from './engine.js';
import { evaluateRule } from './evaluate.js';

type Prefs = Pick<DisplayPrefs, 'units' | 'locale'>;
type EarnedRow = typeof userBadges.$inferSelect;

/** A threshold or progress value in the reader's units; only km/kg/L carry their unit into "{n}". */
export function formatValue(rule: BadgeRule, n: number, prefs: Prefs): string {
  let unit = '';
  if (rule.type === 'lifetime_total' || rule.type === 'best_period') {
    try {
      unit = metricDef(rule.metric as MetricKey).unit;
    } catch {
      unit = '';
    }
  } else if (
    (rule.type === 'single_activity' || rule.type === 'activity_total') &&
    rule.measure === 'distance_km'
  ) {
    unit = 'km';
  }
  if (unit === 'km' || unit === 'kg' || unit === 'L')
    return formatQuantityFlexible(n, unit, 1, prefs);
  return Number.isInteger(n) ? formatInt(n, prefs) : formatFlexible(n, prefs, 1);
}

export function tierLabel(
  d: Pick<DefinitionRow, 'description' | 'rule'>,
  threshold: number,
  prefs: Prefs,
) {
  return d.description.replace(/\{n\}/g, formatValue(d.rule, threshold, prefs));
}

const windowOf = (d: DefinitionRow) =>
  d.windowStart && d.windowEnd ? { start: d.windowStart, end: d.windowEnd } : null;

/** Should this viewer see the badge at all (given whether the shown person earned it)? */
export function isVisible(d: DefinitionRow, earned: boolean, today: string): boolean {
  if (d.status === 'draft') return false;
  if (d.status === 'retired') return earned;
  const w = windowOf(d);
  if (w && !earned) return today >= w.start && today <= w.end;
  return true;
}

export function viewOf(
  d: DefinitionRow,
  rows: EarnedRow[],
  prefs: Prefs,
  opts: { progressValue?: number | null; own?: boolean } = {},
): BadgeView {
  const thresholds = ruleTiers(d.rule);
  const reached = rows.length ? Math.max(...rows.map((r) => r.tier)) : 0;
  const hidden = d.secret && reached === 0;
  const earnedAt = rows.length
    ? rows
        .map((r) => r.earnedAt)
        .reduce((a, b) => (b > a ? b : a))
        .toISOString()
    : null;
  const base = {
    key: d.key,
    secret: d.secret,
    hidden,
    status: d.status,
    window: windowOf(d),
    family: d.family as BadgeFamily,
  };
  if (hidden) {
    return {
      ...base,
      name: '?',
      description: 'A secret badge. Keep moving and you might find it.',
      icon: 'sparkle',
      imageUrl: null,
      tiers: [],
      tier: 0,
      progress: null,
      earnedAt: null,
      ...(opts.own ? { unseen: false } : {}),
    };
  }
  const tiers: BadgeTierView[] = thresholds.map((threshold, i) => ({
    tier: i + 1,
    threshold,
    name: tierName(i + 1, thresholds.length),
    label: tierLabel(d, threshold, prefs),
    earnedAt: rows.find((r) => r.tier === i + 1)?.earnedAt.toISOString() ?? null,
    xp: xpForTier(i + 1, thresholds.length, d.secret, d.xp),
  }));
  const next = tiers.find((t) => t.tier > reached);
  const value = opts.progressValue;
  return {
    ...base,
    name: d.name,
    description: d.description.replace(/\{n\}/g, formatValue(d.rule, thresholds[0]!, prefs)),
    icon: d.icon as BadgeIcon,
    imageUrl: d.imageUrl,
    tiers,
    tier: reached,
    progress:
      next && value != null
        ? {
            value,
            target: next.threshold,
            label: `${formatValue(d.rule, value, prefs)} of ${formatValue(d.rule, next.threshold, prefs)}`,
          }
        : null,
    earnedAt,
    ...(opts.own ? { unseen: rows.some((r) => r.seenAt == null) } : {}),
  };
}

const familyOrder = (f: string) => {
  const i = (BADGE_FAMILIES as readonly string[]).indexOf(f);
  return i < 0 ? 99 : i;
};

async function earnedBy(ctx: AppContext, userId: string): Promise<Map<string, EarnedRow[]>> {
  const rows = await ctx.db
    .select()
    .from(userBadges)
    .where(eq(userBadges.userId, userId))
    .orderBy(asc(userBadges.tier));
  const by = new Map<string, EarnedRow[]>();
  for (const r of rows) by.set(r.badgeKey, [...(by.get(r.badgeKey) ?? []), r]);
  return by;
}

async function progressFor(
  ctx: AppContext,
  user: { id: string; timezone: string },
  defs: DefinitionRow[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < defs.length; i += 6) {
    await Promise.all(
      defs.slice(i, i + 6).map(async (d) => {
        try {
          out.set(d.key, (await evaluateRule(ctx, user, evalDefOf(d))).value);
        } catch (err) {
          ctx.log.warn({ err: String(err), key: d.key }, 'badge progress failed');
        }
      }),
    );
  }
  return out;
}

/** A person's catalog as `viewerId` sees it (viewer's units; progress only when it is their own). */
export async function buildCatalog(
  ctx: AppContext,
  viewerId: string,
  targetId: string,
): Promise<BadgeCatalogResponse> {
  const [viewer, target, prefs] = await Promise.all([
    getUser(ctx, viewerId),
    getUser(ctx, targetId),
    displayFor(ctx, viewerId),
  ]);
  const own = viewerId === targetId;
  const today = todayIn(viewer.timezone, ctx.now());
  const defs = (await ctx.db.select().from(badgeDefinitions)).sort(
    (a, b) =>
      familyOrder(a.family) - familyOrder(b.family) ||
      a.position - b.position ||
      a.name.localeCompare(b.name),
  );
  const earned = await earnedBy(ctx, targetId);
  const shown = defs.filter((d) => isVisible(d, (earned.get(d.key)?.length ?? 0) > 0, today));
  const progress = own
    ? await progressFor(
        ctx,
        target,
        shown.filter(
          (d) => d.status === 'live' && !(earned.get(d.key)?.length === thresholdsOf(d)),
        ),
      )
    : new Map<string, number>();
  const badges = shown.map((d) =>
    viewOf(d, earned.get(d.key) ?? [], prefs, { progressValue: progress.get(d.key), own }),
  );
  const earnedKeys = new Set(badges.filter((b) => b.tier > 0).map((b) => b.key));
  return {
    user: toPublicUser(target),
    level: levelFor(target.badgeXp),
    showcase: target.badgeShowcase.filter((k) => earnedKeys.has(k)),
    badges,
    earnedCount: earnedKeys.size,
  };
}

const thresholdsOf = (d: DefinitionRow) => ruleTiers(d.rule).length;

async function canSeeChallenge(ctx: AppContext, viewerId: string, challengeId: string) {
  const [row] = await ctx.db
    .select({ vis: challenges.visibility })
    .from(challenges)
    .where(eq(challenges.id, challengeId));
  if (!row) return false;
  if (row.vis === 'public') return true;
  const [mine] = await ctx.db
    .select({ s: challengeParticipants.state })
    .from(challengeParticipants)
    .where(
      and(
        eq(challengeParticipants.challengeId, challengeId),
        eq(challengeParticipants.userId, viewerId),
      ),
    );
  return !!mine && mine.s !== 'declined';
}

export async function buildDetail(
  ctx: AppContext,
  viewerId: string,
  key: string,
  targetId: string,
): Promise<BadgeDetailResponse> {
  const [d] = await ctx.db.select().from(badgeDefinitions).where(eq(badgeDefinitions.key, key));
  if (!d) throw notFound('Badge not found');
  const [viewer, target, prefs] = await Promise.all([
    getUser(ctx, viewerId),
    getUser(ctx, targetId),
    displayFor(ctx, viewerId),
  ]);
  const own = viewerId === targetId;
  const rows = (await earnedBy(ctx, targetId)).get(key) ?? [];
  if (!isVisible(d, rows.length > 0, todayIn(viewer.timezone, ctx.now())))
    throw notFound('Badge not found');
  const progress =
    own && d.status === 'live' ? (await progressFor(ctx, target, [d])).get(key) : undefined;

  const history = [];
  for (const r of rows) {
    let context = r.context;
    // Someone else's earn shouldn't leak the name of a private challenge you aren't in.
    if (!own && typeof context.challengeId === 'string') {
      if (!(await canSeeChallenge(ctx, viewerId, context.challengeId))) {
        const { challengeId: _a, challengeName: _b, ...rest } = context;
        context = rest;
      }
    }
    history.push({ tier: r.tier, earnedAt: r.earnedAt.toISOString(), context });
  }
  const friends = await friendIds(ctx, viewerId);
  const [withIt] = friends.length
    ? await ctx.db
        .select({ n: sql<number>`count(distinct ${userBadges.userId})::int` })
        .from(userBadges)
        .where(and(eq(userBadges.badgeKey, key), inArray(userBadges.userId, friends)))
    : [{ n: 0 }];
  const [all] = await ctx.db
    .select({ n: sql<number>`count(distinct ${userBadges.userId})::int` })
    .from(userBadges)
    .innerJoin(users, eq(users.id, userBadges.userId))
    .where(and(eq(userBadges.badgeKey, key), eq(users.isDemo, false)));
  return {
    badge: viewOf(d, rows, prefs, { progressValue: progress, own }),
    history,
    friendsWithIt: withIt?.n ?? 0,
    earnedByCount: all?.n ?? 0,
  };
}

/** Badges earned but not yet celebrated (newest first). */
export async function buildUnseen(ctx: AppContext, userId: string): Promise<UnseenBadgesResponse> {
  const [me, prefs] = await Promise.all([getUser(ctx, userId), displayFor(ctx, userId)]);
  const unseenRows = await ctx.db
    .select()
    .from(userBadges)
    .where(and(eq(userBadges.userId, userId), isNull(userBadges.seenAt)))
    .orderBy(desc(userBadges.earnedAt));
  const keys = [...new Set(unseenRows.map((r) => r.badgeKey))].slice(0, 20);
  const defs = keys.length
    ? await ctx.db.select().from(badgeDefinitions).where(inArray(badgeDefinitions.key, keys))
    : [];
  const earned = await earnedBy(ctx, userId);
  const badges = keys.flatMap((k) => {
    const d = defs.find((x) => x.key === k);
    return d ? [viewOf(d, earned.get(k) ?? [], prefs, { own: true })] : [];
  });
  return { badges, level: levelFor(me.badgeXp) };
}

export async function markSeen(ctx: AppContext, userId: string, keys: string[]): Promise<void> {
  if (!keys.length) return;
  await ctx.db
    .update(userBadges)
    .set({ seenAt: ctx.now() })
    .where(
      and(
        eq(userBadges.userId, userId),
        inArray(userBadges.badgeKey, keys),
        isNull(userBadges.seenAt),
      ),
    );
}

/** Pin up to three earned badges to the profile. Throws if any isn't earned. */
export async function setShowcase(
  ctx: AppContext,
  userId: string,
  keys: string[],
): Promise<string[]> {
  const unique = [...new Set(keys)];
  if (unique.length) {
    const rows = await ctx.db
      .selectDistinct({ key: userBadges.badgeKey })
      .from(userBadges)
      .where(and(eq(userBadges.userId, userId), inArray(userBadges.badgeKey, unique)));
    if (rows.length !== unique.length)
      throw new HttpError(400, 'You can only pin badges you have earned.', 'not_earned');
  }
  await ctx.db.update(users).set({ badgeShowcase: unique }).where(eq(users.id, userId));
  return unique;
}
