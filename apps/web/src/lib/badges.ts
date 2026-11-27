/**
 * Pure helpers for the badge screens: ordering the catalog, picking what a profile shows, deciding
 * what deserves a full-screen celebration, and the little bits of wording ("Gold", "Ends in 3
 * days"). No React here so they are easy to test.
 */
import {
  daysLeftInWindow,
  levelFor,
  tierName,
  type BadgeView,
  type LevelInfo,
  type TierName,
} from '@gauntlet/shared';

const TIER_ORDER: Record<TierName, number> = { bronze: 1, silver: 2, gold: 3, platinum: 4 };

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Gold" for tier 3 of a four-tier badge, or null for a single-tier one. */
export function tierLabelOf(b: Pick<BadgeView, 'tier' | 'tiers'>): string | null {
  const t = b.tier > 0 ? tierName(b.tier, b.tiers.length) : null;
  return t ? cap(t) : null;
}

/** "Gold · Million Stepper", or just the name for a one-tier badge. */
export function earnedLine(b: Pick<BadgeView, 'name' | 'tier' | 'tiers'>): string {
  const t = tierLabelOf(b);
  return t ? `${t} · ${b.name}` : b.name;
}

export const progressPct = (b: Pick<BadgeView, 'progress'>): number =>
  b.progress && b.progress.target > 0
    ? Math.max(0, Math.min(1, b.progress.value / b.progress.target))
    : 0;

export const isEarned = (b: BadgeView) => b.tier > 0;
export const isLive = (b: BadgeView) => b.status === 'live';

/** A windowed badge you can still go for right now (live, not earned, not over). */
export function isLimitedRunning(b: BadgeView, today: string): boolean {
  return (
    !!b.window &&
    b.status === 'live' &&
    b.tier === 0 &&
    !b.hidden &&
    today <= b.window.end &&
    today >= b.window.start
  );
}

/** "Ends in 5 days", "Ends tomorrow", "Ends today". */
export function endsText(window: { end: string }, today: string): string {
  const d = daysLeftInWindow(window, today);
  if (d <= 1) return 'Ends today';
  if (d === 2) return 'Ends tomorrow';
  return `Ends in ${d} days`;
}

export interface CatalogGroups {
  limited: BadgeView[];
  earned: BadgeView[];
  inProgress: BadgeView[];
  locked: BadgeView[];
  secret: BadgeView[];
}

/** Earned first (best tier first), then in progress by % done, then locked; secrets last as "?". */
export function groupCatalog(badges: BadgeView[], today: string): CatalogGroups {
  const limited = badges.filter((b) => isLimitedRunning(b, today));
  const limitedKeys = new Set(limited.map((b) => b.key));
  const rest = badges.filter((b) => !limitedKeys.has(b.key));
  const earned = rest
    .filter(isEarned)
    .sort(
      (a, b) =>
        (b.earnedAt ?? '').localeCompare(a.earnedAt ?? '') ||
        b.tier / Math.max(1, b.tiers.length) - a.tier / Math.max(1, a.tiers.length),
    );
  const open = rest.filter((b) => !isEarned(b) && !b.hidden);
  const withProgress = open
    .filter((b) => progressPct(b) > 0)
    .sort((a, b) => progressPct(b) - progressPct(a));
  const locked = open.filter((b) => progressPct(b) === 0);
  // A badge you hold but haven't maxed also has progress: it stays in "earned".
  return {
    limited,
    earned,
    inProgress: withProgress,
    locked,
    secret: rest.filter((b) => b.hidden),
  };
}

/** XP value of a badge for ordering: the reached tier's worth. */
export const xpOf = (b: BadgeView) =>
  b.tiers.filter((t) => t.tier <= b.tier).reduce((s, t) => s + t.xp, 0);

/** The (up to 3) badges a profile shows: the pinned ones, else the best earned by tier then XP. */
export function pickShowcase(badges: BadgeView[], pinned: string[]): BadgeView[] {
  const byKey = new Map(badges.map((b) => [b.key, b]));
  const pins = pinned.flatMap((k) => {
    const b = byKey.get(k);
    return b && isEarned(b) ? [b] : [];
  });
  if (pins.length) return pins.slice(0, 3);
  return badges
    .filter(isEarned)
    .sort((a, b) => {
      const ta =
        TIER_ORDER[tierName(a.tier, a.tiers.length) ?? 'bronze'] + (a.tiers.length <= 1 ? 1.5 : 0);
      const tb =
        TIER_ORDER[tierName(b.tier, b.tiers.length) ?? 'bronze'] + (b.tiers.length <= 1 ? 1.5 : 0);
      return tb - ta || xpOf(b) - xpOf(a) || a.key.localeCompare(b.key);
    })
    .slice(0, 3);
}

/** Share of the way from this level to the next, 0 to 1. */
export const levelFraction = (l: LevelInfo) =>
  l.nextLevelXp > l.levelXp
    ? Math.max(0, Math.min(1, (l.xp - l.levelXp) / (l.nextLevelXp - l.levelXp)))
    : 0;

/** Gold, platinum, a one-tier secret, or anything limited-time: worth stopping the app for. */
export function isCelebratory(b: BadgeView): boolean {
  const t = tierName(b.tier, b.tiers.length);
  return t === 'gold' || t === 'platinum' || (b.secret && b.tiers.length === 1) || !!b.window;
}

/** XP these badges just brought in: every tier earned within minutes of the newest one. */
export function xpGained(badges: BadgeView[]): number {
  let sum = 0;
  for (const b of badges) {
    const last = Math.max(0, ...b.tiers.map((t) => (t.earnedAt ? Date.parse(t.earnedAt) : 0)));
    for (const t of b.tiers)
      if (t.earnedAt && last - Date.parse(t.earnedAt) <= 5 * 60_000) sum += t.xp;
  }
  return sum;
}

export interface CelebrationPlan {
  /** Full-screen moments, best first (at most 3). */
  full: BadgeView[];
  /** Everything else, told in a toast. */
  quiet: BadgeView[];
  xp: number;
  level: LevelInfo;
  /** The level you were on before these badges, when it changed. */
  leveledUpFrom: number | null;
}

export const MAX_FULL_SCREEN = 3;

export function planCelebration(badges: BadgeView[], level: LevelInfo): CelebrationPlan {
  const celebratory = badges
    .filter(isCelebratory)
    .sort(
      (a, b) =>
        (TIER_ORDER[tierName(b.tier, b.tiers.length) ?? 'gold'] ?? 3) -
        (TIER_ORDER[tierName(a.tier, a.tiers.length) ?? 'gold'] ?? 3),
    );
  const full = celebratory.slice(0, MAX_FULL_SCREEN);
  const fullKeys = new Set(full.map((b) => b.key));
  const xp = xpGained(badges);
  const before = levelFor(Math.max(0, level.xp - xp)).level;
  return {
    full,
    quiet: badges.filter((b) => !fullKeys.has(b.key)),
    xp,
    level,
    leveledUpFrom: before < level.level ? before : null,
  };
}
