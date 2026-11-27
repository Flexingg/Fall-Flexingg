/**
 * The light badge summary the Today screen and the profile header show: level, XP, how many badges
 * and the newest one earned. Far cheaper than the full catalog (no per-badge progress to work out).
 */
import type { BadgeIcon, LevelInfo, TierName } from './badges.js';

export interface BadgeSummary {
  level: LevelInfo;
  earnedCount: number;
  /** Earned and not celebrated yet. */
  unseenCount: number;
  /** The badge earned most recently (null before the first). */
  latest: {
    key: string;
    name: string;
    icon: BadgeIcon;
    imageUrl: string | null;
    tier: number;
    tierName: TierName | null;
    earnedAt: string;
  } | null;
}
