/**
 * The badge engine. checkBadges() looks at what a person has done, awards every tier they have
 * newly reached (one user_badges row per tier, never removed), keeps users.badge_xp in step, and
 * tells them: one grouped notification per check, and a feed post only for the big ones (gold,
 * platinum, a one-off secret badge, a limited-time badge).
 *
 * Idempotent: rows are inserted with ON CONFLICT DO NOTHING and only rows that really went in are
 * announced, so running a check twice, or two at once, never double-awards or double-notifies.
 *
 * The very first check for a person (connecting an account pulls weeks of history) is a backfill:
 * rows are marked backfilled and already seen, and they get ONE "you've unlocked N badges" note
 * rather than a pile of celebrations. backfillBadge() does the same for everyone when a badge is
 * new or its rule changes. The demo account never earns live (it has a fixed sample set).
 */
import {
  ruleTiers,
  tierName,
  xpForTier,
  type BadgeFeedPayload,
  type BadgeIcon,
  type BadgePreviewResponse,
  type BadgeDraft,
  type BadgeRule,
  type TierName,
} from '@gauntlet/shared';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { badgeDefinitions, feedEvents, serverState, userBadges, users } from '../../db/schema.js';
import { notify } from '../notify.js';
import { getUser, toPublicUser } from '../users.js';
import { DATA_RULES, evaluateRule, windowOpen, type EvalDef } from './evaluate.js';

/** JSON with sorted keys, so rules compare equal however Postgres' jsonb happened to order them. */
export function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as object).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
}

export type DefinitionRow = typeof badgeDefinitions.$inferSelect;

export type CheckReason = 'sync' | 'challenge' | 'social';

export interface CheckOptions {
  reason: CheckReason;
  /** Quietly award everything already earned (no celebration). */
  backfill?: boolean;
  /**
   * A history import just stored older data: award what it unlocked quietly (no per-badge
   * celebration or feed post) and tell the person once, "Your history unlocked N badges".
   */
  history?: boolean;
}

export interface EarnedBadge {
  key: string;
  tier: number;
}

/** What each kind of trigger can have changed, so a sync doesn't re-run challenge queries. */
function relevant(reason: CheckReason, type: BadgeRule['type'], rule: BadgeRule): boolean {
  if (reason === 'sync')
    return DATA_RULES.has(type) || (rule.type === 'social' && rule.event === 'personal_records');
  if (reason === 'challenge') return type === 'challenge_result' || type === 'social';
  return type === 'social';
}

export const evalDefOf = (d: DefinitionRow): EvalDef => ({
  rule: d.rule,
  window: d.windowStart && d.windowEnd ? { start: d.windowStart, end: d.windowEnd } : null,
  countsManual: d.countsManual,
});

const initKey = (userId: string) => `badge_init:${userId}`;

async function isInitialised(ctx: AppContext, userId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ key: serverState.key })
    .from(serverState)
    .where(eq(serverState.key, initKey(userId)));
  return !!row;
}

async function markInitialised(ctx: AppContext, userIds: string[]): Promise<void> {
  if (!userIds.length) return;
  await ctx.db
    .insert(serverState)
    .values(userIds.map((id) => ({ key: initKey(id), value: true, updatedAt: ctx.now() })))
    .onConflictDoNothing();
}

/** One check at a time per person, so two overlapping triggers can't race each other. */
const chains = new Map<string, Promise<unknown>>();

export function checkBadges(
  ctx: AppContext,
  userId: string,
  opts: CheckOptions,
): Promise<EarnedBadge[]> {
  const prev = chains.get(userId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => doCheck(ctx, userId, opts));
  chains.set(userId, next);
  void next
    .finally(() => {
      if (chains.get(userId) === next) chains.delete(userId);
    })
    .catch(() => undefined);
  return next;
}

/** Run `fn` over items a few at a time. */
async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

async function doCheck(
  ctx: AppContext,
  userId: string,
  opts: CheckOptions,
): Promise<EarnedBadge[]> {
  const user = await getUser(ctx, userId);
  if (user.isDemo) return [];
  const live = await ctx.db
    .select()
    .from(badgeDefinitions)
    .where(eq(badgeDefinitions.status, 'live'));
  if (!live.length) return [];
  const initialised = await isInitialised(ctx, userId);
  const firstCheck = !initialised;
  const everything = !!opts.backfill || firstCheck;
  // A history import is quiet like a backfill, but only data-driven badges can have changed.
  const backfill = everything || !!opts.history;

  const defs = live.filter((d) => everything || relevant(opts.reason, d.rule.type, d.rule));
  const owned = new Set(
    (
      await ctx.db
        .select({ key: userBadges.badgeKey, tier: userBadges.tier })
        .from(userBadges)
        .where(eq(userBadges.userId, userId))
    ).map((r) => `${r.key}:${r.tier}`),
  );
  const now = ctx.now();
  const rows: (typeof userBadges.$inferInsert)[] = [];
  await inBatches(defs, 6, async (d) => {
    const ed = evalDefOf(d);
    if (!windowOpenFor(ctx, user.timezone, ed)) return;
    const ev = await evaluateRule(ctx, { id: userId, timezone: user.timezone }, ed);
    ruleTiers(d.rule).forEach((threshold, i) => {
      if (ev.value < threshold || owned.has(`${d.key}:${i + 1}`)) return;
      rows.push({
        userId,
        badgeKey: d.key,
        tier: i + 1,
        earnedAt: now,
        version: d.version,
        context: ev.contextFor(threshold),
        backfilled: backfill,
        seenAt: backfill ? now : null,
      });
    });
  });

  let inserted: (typeof userBadges.$inferSelect)[] = [];
  if (rows.length)
    inserted = await ctx.db.insert(userBadges).values(rows).onConflictDoNothing().returning();
  if (firstCheck) await markInitialised(ctx, [userId]);
  if (inserted.length) await recomputeXp(ctx, userId);

  if (inserted.length) {
    const byKey = new Map(live.map((d) => [d.key, d]));
    if (!backfill) await announce(ctx, userId, inserted, byKey);
    else if (firstCheck || opts.history) {
      const n = new Set(inserted.map((r) => r.badgeKey)).size;
      await notify(ctx, userId, {
        kind: 'badge',
        title: opts.history ? 'Your history unlocked badges' : 'Your badges are in',
        body: opts.history
          ? `Your history unlocked ${n} ${n === 1 ? 'badge' : 'badges'} — take a look`
          : `You've unlocked ${n} ${n === 1 ? 'badge' : 'badges'} — take a look`,
        url: '/badges',
        payload: { keys: [...new Set(inserted.map((r) => r.badgeKey))], summary: true },
      });
    }
  }
  return inserted.map((r) => ({ key: r.badgeKey, tier: r.tier }));
}

function windowOpenFor(ctx: AppContext, timezone: string, def: EvalDef): boolean {
  if (!def.window) return true;
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ctx.now());
  return windowOpen(def.window, today);
}

/** Total XP from everything earned, whatever has happened to the definitions since. */
export async function recomputeXp(ctx: AppContext, userId: string): Promise<number> {
  const rows = await ctx.db
    .select({ tier: userBadges.tier, d: badgeDefinitions })
    .from(userBadges)
    .innerJoin(badgeDefinitions, eq(badgeDefinitions.key, userBadges.badgeKey))
    .where(eq(userBadges.userId, userId));
  const xp = rows.reduce(
    (sum, r) => sum + xpForTier(r.tier, ruleTiers(r.d.rule).length, r.d.secret, r.d.xp),
    0,
  );
  await ctx.db.update(users).set({ badgeXp: xp }).where(eq(users.id, userId));
  return xp;
}

/** Tell the person (grouped), and post the standout one to the feed. */
async function announce(
  ctx: AppContext,
  userId: string,
  inserted: (typeof userBadges.$inferSelect)[],
  defs: Map<string, DefinitionRow>,
) {
  // The highest tier reached per badge in this check.
  const top = new Map<string, number>();
  for (const r of inserted) top.set(r.badgeKey, Math.max(top.get(r.badgeKey) ?? 0, r.tier));
  const entries = [...top]
    .flatMap(([key, tier]) => {
      const d = defs.get(key);
      return d ? [{ d, tier, tn: tierName(tier, ruleTiers(d.rule).length) }] : [];
    })
    .sort(
      (a, b) =>
        xpForTier(b.tier, ruleTiers(b.d.rule).length, b.d.secret, b.d.xp) -
        xpForTier(a.tier, ruleTiers(a.d.rule).length, a.d.secret, a.d.xp),
    );
  if (!entries.length) return;
  const label = (e: (typeof entries)[number]) =>
    `${e.tn ? `${e.tn.charAt(0).toUpperCase()}${e.tn.slice(1)} · ` : ''}${e.d.name}`;
  await notify(ctx, userId, {
    kind: 'badge',
    title: entries.length === 1 ? 'Badge earned' : 'New badges',
    body:
      entries.length === 1
        ? `You earned ${label(entries[0]!)}`
        : `You earned ${entries.length} badges`,
    url: '/badges',
    payload: { keys: entries.map((e) => e.d.key) },
  });

  const standout = entries.find(
    (e) =>
      e.tn === 'gold' ||
      e.tn === 'platinum' ||
      (e.d.secret && ruleTiers(e.d.rule).length === 1) ||
      !!e.d.windowStart,
  );
  if (!standout) return;
  const payload: BadgeFeedPayload = {
    key: standout.d.key,
    name: standout.d.name,
    tier: standout.tier,
    tierName: standout.tn as TierName | null,
    icon: standout.d.icon as BadgeIcon,
    imageUrl: standout.d.imageUrl,
    more: entries.length - 1,
  };
  await ctx.db.insert(feedEvents).values({
    actorId: userId,
    challengeId: null,
    kind: 'badge_earned',
    payload: payload as unknown as Record<string, unknown>,
  });
}

// ---------- Backfill and preview ----------

const BATCH = 10;

async function realUsers(ctx: AppContext, after: string | null, limit: number) {
  return ctx.db
    .select({
      id: users.id,
      timezone: users.timezone,
      displayName: users.displayName,
      badgeXp: users.badgeXp,
    })
    .from(users)
    .where(after ? and(eq(users.isDemo, false), gt(users.id, after)) : eq(users.isDemo, false))
    .orderBy(asc(users.id))
    .limit(limit);
}

/**
 * Award a badge to everyone who already qualifies, quietly (backfilled, already seen). Run when a
 * badge goes live or its rule changes. Returns how many tier rows were added.
 */
export async function backfillBadge(ctx: AppContext, key: string): Promise<number> {
  const [d] = await ctx.db.select().from(badgeDefinitions).where(eq(badgeDefinitions.key, key));
  if (!d || d.status !== 'live') return 0;
  const ed = evalDefOf(d);
  const tiers = ruleTiers(d.rule);
  let added = 0;
  let after: string | null = null;
  for (;;) {
    const batch = await realUsers(ctx, after, 100);
    if (!batch.length) break;
    after = batch[batch.length - 1]!.id;
    const have = await ctx.db
      .select({ userId: userBadges.userId, tier: userBadges.tier })
      .from(userBadges)
      .where(
        and(
          eq(userBadges.badgeKey, key),
          inArray(
            userBadges.userId,
            batch.map((b) => b.id),
          ),
        ),
      );
    const owned = new Set(have.map((h) => `${h.userId}:${h.tier}`));
    const touched: string[] = [];
    await inBatches(batch, BATCH, async (u) => {
      if (!windowOpenFor(ctx, u.timezone, ed)) return;
      const ev = await evaluateRule(ctx, u, ed);
      const rows = tiers.flatMap((threshold, i) =>
        ev.value >= threshold && !owned.has(`${u.id}:${i + 1}`)
          ? [
              {
                userId: u.id,
                badgeKey: key,
                tier: i + 1,
                earnedAt: ctx.now(),
                version: d.version,
                context: ev.contextFor(threshold),
                backfilled: true,
                seenAt: ctx.now(),
              },
            ]
          : [],
      );
      if (!rows.length) return;
      const got = await ctx.db.insert(userBadges).values(rows).onConflictDoNothing().returning();
      added += got.length;
      if (got.length) touched.push(u.id);
    });
    for (const id of touched) await recomputeXp(ctx, id);
    // Everyone seen here has had their launch backfill: their next real earn is a celebration.
    await markInitialised(
      ctx,
      batch.map((b) => b.id),
    );
  }
  return added;
}

/** Who would have this badge if it went live now (nothing is written). */
export async function previewDraft(
  ctx: AppContext,
  draft: BadgeDraft,
): Promise<BadgePreviewResponse> {
  const ed: EvalDef = { rule: draft.rule, window: draft.window, countsManual: draft.countsManual };
  const tiers = ruleTiers(draft.rule);
  const byTier = tiers.map(() => 0);
  const got: { user: { id: string; displayName: string; badgeXp: number }; tier: number }[] = [];
  let after: string | null = null;
  for (;;) {
    const batch = await realUsers(ctx, after, 100);
    if (!batch.length) break;
    after = batch[batch.length - 1]!.id;
    await inBatches(batch, BATCH, async (u) => {
      if (!windowOpenFor(ctx, u.timezone, ed)) return;
      const ev = await evaluateRule(ctx, u, ed);
      const tier = tiers.filter((t) => ev.value >= t).length;
      if (!tier) return;
      for (let i = 0; i < tier; i++) byTier[i]!++;
      got.push({ user: u, tier });
    });
  }
  // `byTier[i]` counts people who reached tier i+1 or higher.
  const wouldEarn = byTier[0] ?? 0;
  const sample = got
    .sort((a, b) => b.tier - a.tier || a.user.displayName.localeCompare(b.user.displayName))
    .slice(0, 8)
    .map((g) => ({ user: toPublicUser(g.user), tier: g.tier }));
  return { wouldEarn, byTier, sample };
}
