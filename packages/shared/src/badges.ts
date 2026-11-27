/**
 * Badges and levels: the shared contract.
 *
 * Badges are data, not code. Each one is a row in badge_definitions holding a small declarative
 * rule (below) that the server knows how to evaluate. The app never has a list of badges; it draws
 * whatever the server sends, so new badges (made in Admin → Badges, or suggested from the Garmin
 * badge database) appear without an app update. Only a brand-new *kind* of rule needs a server
 * update, and that is a redeploy, not an app release.
 *
 * Rules are validated with badgeRuleSchema everywhere they come in (admin edits, LLM suggestions,
 * seeds). Nothing is ever executed from a rule: each rule type maps to one tested query.
 */
import { z } from 'zod';
import type { PublicUser } from './api.js';

// ---------- Tiers, XP and levels ----------

/** Up to four tiers per badge. A badge with one threshold has a single tier and no medal colour. */
export const TIER_NAMES = ['bronze', 'silver', 'gold', 'platinum'] as const;
export type TierName = (typeof TIER_NAMES)[number];

/** XP for reaching each tier (index 0 = bronze). A single-tier badge is worth SINGLE_XP. */
export const TIER_XP = [10, 25, 60, 150] as const;
export const SINGLE_XP = 25;
/** Extra XP on top for a secret badge. */
export const SECRET_BONUS_XP = 15;

/** Tier name for tier n (1-based) of a badge with `count` tiers; null for single-tier badges. */
export function tierName(tier: number, count: number): TierName | null {
  if (count <= 1) return null;
  return TIER_NAMES[Math.min(tier, TIER_NAMES.length) - 1] ?? null;
}

/** XP earned for reaching `tier` (1-based) on a badge with `count` tiers (counts that tier only). */
export function xpForTier(
  tier: number,
  count: number,
  secret: boolean,
  override?: number[] | null,
) {
  const base = override?.[tier - 1] ?? (count <= 1 ? SINGLE_XP : (TIER_XP[tier - 1] ?? 150));
  return base + (secret && tier === 1 ? SECRET_BONUS_XP : 0);
}

/** Total XP needed to reach level n (level 1 needs 0). Early levels come quickly, later ones slowly. */
export function xpToReach(level: number): number {
  return level <= 1 ? 0 : Math.round(50 * Math.pow(level - 1, 1.5));
}

export interface LevelInfo {
  level: number;
  xp: number;
  /** XP at the start of this level and at the next one. */
  levelXp: number;
  nextLevelXp: number;
}

export function levelFor(xp: number): LevelInfo {
  let level = 1;
  while (xpToReach(level + 1) <= xp) level++;
  return { level, xp, levelXp: xpToReach(level), nextLevelXp: xpToReach(level + 1) };
}

// ---------- Rules ----------

/** Daily metrics a rule can read (see metrics.ts; lift_max:/lift_e1rm: are allowed too). */
export const BADGE_DAY_METRICS = [
  'steps',
  'distance',
  'active_minutes',
  'active_calories',
  'workouts',
  'sleep',
  'lift_volume',
  'lift_sets',
  'water',
  'water_goal',
  'calorie_adherence',
  'fast_hours',
  'fasts_completed',
] as const;
export type BadgeDayMetric = (typeof BADGE_DAY_METRICS)[number];

/** Activity types badges understand, normalised from the workout's name/kind at sync. */
export const ACTIVITY_SPORTS = [
  'any',
  'run',
  'walk',
  'hike',
  'ride',
  'swim',
  'strength',
  'yoga',
  'cardio',
  'other',
] as const;
export type ActivitySport = (typeof ACTIVITY_SPORTS)[number];

export const ACTIVITY_MEASURES = ['distance_km', 'minutes', 'kcal'] as const;
export type ActivityMeasure = (typeof ACTIVITY_MEASURES)[number];

/** Social things people do in Gauntlet that rules can count. */
export const SOCIAL_EVENTS = [
  'reactions_sent',
  'comments_sent',
  'challenges_created',
  'challenges_joined',
  'team_challenges_joined',
  'friends',
  /** People who joined a challenge or became a friend through an invite you sent. */
  'invite_joins',
  'stakes_paid',
  'rematches_won',
  'personal_records',
] as const;
export type SocialEvent = (typeof SOCIAL_EVENTS)[number];

/** One-off challenge moments worked out from the daily standings history. */
export const CHALLENGE_DRAMA = [
  'comeback',
  'photo_finish',
  'wire_to_wire',
  'giant_killer',
] as const;
export type ChallengeDrama = (typeof CHALLENGE_DRAMA)[number];

const metric = z
  .string()
  .refine(
    (m) =>
      (BADGE_DAY_METRICS as readonly string[]).includes(m) ||
      /^lift_(max|e1rm):[\w .'-]{1,60}$/.test(m),
    'Unknown metric',
  );
/** Thresholds for each tier, increasing, 1 to 4 of them. */
const tiers = z
  .array(z.number().positive())
  .min(1)
  .max(4)
  .refine((t) => t.every((v, i) => i === 0 || v > t[i - 1]!), 'Tiers must increase');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Local hour range [from, to), e.g. 0–4 for "after midnight". Wraps past midnight when from > to. */
const hours = z.object({
  from: z.number().int().min(0).max(23),
  to: z.number().int().min(1).max(24),
});

export const badgeRuleSchema = z.discriminatedUnion('type', [
  /** Everything added up, all time (or inside the badge's window). "1,000,000 steps". */
  z.object({ type: z.literal('lifetime_total'), metric, tiers }),
  /** Best single day / week (Mon–Sun) / month total. "A 30,000-step day". */
  z.object({
    type: z.literal('best_period'),
    metric,
    period: z.enum(['day', 'week', 'month']),
    tiers,
  }),
  /** Consecutive days with metric ≥ min. "7-day 10k streak". */
  z.object({ type: z.literal('streak'), metric, min: z.number().positive(), tiers }),
  /** Number of days (not necessarily in a row) with metric ≥ min. "20 days with 30+ active minutes". */
  z.object({
    type: z.literal('count_days'),
    metric,
    min: z.number().positive(),
    tiers,
    hours: hours.optional(),
  }),
  /** One activity reaching a size. "A 10 km run", "A 2-hour ride". Tiers are sizes of one activity. */
  z.object({
    type: z.literal('single_activity'),
    sport: z.enum(ACTIVITY_SPORTS),
    measure: z.enum(ACTIVITY_MEASURES),
    tiers,
    /** Only activities that started in this local hour range (e.g. before 6 am). */
    hours: hours.optional(),
  }),
  /** How many activities. Optionally only those of at least `min` of `measure`. "50 runs of 5 km+". */
  z.object({
    type: z.literal('activity_count'),
    sport: z.enum(ACTIVITY_SPORTS),
    tiers,
    measure: z.enum(ACTIVITY_MEASURES).optional(),
    min: z.number().positive().optional(),
    hours: hours.optional(),
  }),
  /** Activity amounts added up. "Ride 100 km" (usually inside a window). */
  z.object({
    type: z.literal('activity_total'),
    sport: z.enum(ACTIVITY_SPORTS),
    measure: z.enum(ACTIVITY_MEASURES),
    tiers,
  }),
  /** Finished group challenges. Tiers count how many matched. */
  z.object({
    type: z.literal('challenge_result'),
    /** 1 = won, 3 = podium; omitted = just finished one with a score. */
    place: z.union([z.literal(1), z.literal(3)]).optional(),
    minParticipants: z.number().int().min(2).optional(),
    teamOnly: z.boolean().optional(),
    drama: z.enum(CHALLENGE_DRAMA).optional(),
    tiers,
  }),
  /** Counting social things. "Send 50 reactions". */
  z.object({ type: z.literal('social'), event: z.enum(SOCIAL_EVENTS), tiers }),
  /** Active on a date (every year): metric ≥ min on month/day. "Moved on New Year's Day". */
  z.object({
    type: z.literal('date_active'),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
    metric: metric.default('steps'),
    min: z.number().positive().default(1000),
  }),
]);
export type BadgeRule = z.infer<typeof badgeRuleSchema>;
export type BadgeRuleType = BadgeRule['type'];

/** Thresholds of a rule (date_active has a single implicit tier). */
export function ruleTiers(rule: BadgeRule): number[] {
  return 'tiers' in rule ? rule.tiers : [1];
}

// ---------- Definitions ----------

export const BADGE_FAMILIES = [
  'movement',
  'big_days',
  'consistency',
  'competition',
  'drama',
  'rivalry',
  'social',
  'strength',
  'fasting',
  'seasonal',
  'secret',
] as const;
export type BadgeFamily = (typeof BADGE_FAMILIES)[number];

export const BADGE_FAMILY_LABELS: Record<BadgeFamily, string> = {
  movement: 'Movement',
  big_days: 'Big days',
  consistency: 'Consistency',
  competition: 'Competition',
  drama: 'Drama',
  rivalry: 'Rivalry',
  social: 'Social',
  strength: 'Strength',
  fasting: 'Fasting',
  seasonal: 'Limited time',
  secret: 'Secret',
};

/**
 * Built-in badge icons. The web app draws these (components/BadgeIcon.tsx); an uploaded image
 * (imageUrl) is used instead when set. New names need an app update, so admins pick from this list
 * or upload an image.
 */
export const BADGE_ICONS = [
  'shoe',
  'steps',
  'route',
  'mountain',
  'bike',
  'wave',
  'run',
  'walk',
  'hike',
  'flame',
  'bolt',
  'heart',
  'timer',
  'stopwatch',
  'calendar',
  'streak',
  'sunrise',
  'moon',
  'star',
  'crown',
  'trophy',
  'medal',
  'podium',
  'flag',
  'target',
  'rocket',
  'dumbbell',
  'kettlebell',
  'barbell',
  'muscle',
  'hourglass',
  'drop',
  'leaf',
  'snowflake',
  'sun',
  'gift',
  'party',
  'handshake',
  'chat',
  'clap',
  'fire_emoji',
  'swords',
  'shield',
  'skull',
  'ghost',
  'owl',
  'coffee',
  'dice',
  'globe',
  'compass',
  'map',
  'camera',
  'sparkle',
  'gem',
  'infinity',
  'hundred',
  'turtle',
  'rabbit',
  'lightning',
  'anchor',
] as const;
export type BadgeIcon = (typeof BADGE_ICONS)[number];

export const BADGE_STATUSES = ['draft', 'live', 'retired'] as const;
export type BadgeStatus = (typeof BADGE_STATUSES)[number];
export type BadgeOrigin = 'builtin' | 'admin' | 'garmin';

/** What an admin edits (and what an LLM suggestion proposes). */
export const badgeDraftSchema = z.object({
  /** Stable id, lowercase with dashes; can't change once live. */
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'Use lowercase letters, digits and dashes'),
  name: z.string().trim().min(2).max(40),
  /** One plain sentence: what to do to earn it. "{n}" is replaced by the tier's threshold. */
  description: z.string().trim().min(4).max(160),
  family: z.enum(BADGE_FAMILIES),
  icon: z.enum(BADGE_ICONS),
  /** Uploaded image (from POST /api/admin/badges/images) shown instead of the icon. */
  imageUrl: z.string().max(200).nullable().default(null),
  secret: z.boolean().default(false),
  rule: badgeRuleSchema,
  /** Only activity inside these dates counts, and the badge can only be earned then. */
  window: z.object({ start: isoDate, end: isoDate }).nullable().default(null),
  /** Optional XP per tier instead of the defaults. */
  xp: z.array(z.number().int().min(0).max(1000)).max(4).nullable().default(null),
  /** Manually entered data counts? Competition/drama/rivalry rules ignore this and never count it. */
  countsManual: z.boolean().default(true),
});
export type BadgeDraft = z.infer<typeof badgeDraftSchema>;

// ---------- What people see ----------

export interface BadgeTierView {
  tier: number;
  threshold: number;
  /** "bronze"… or null for a single-tier badge. */
  name: TierName | null;
  /** Wording for this tier, e.g. "Walk 1,000,000 steps" (units follow the viewer). */
  label: string;
  earnedAt: string | null;
  xp: number;
}

export interface BadgeView {
  key: string;
  name: string;
  description: string;
  family: BadgeFamily;
  icon: BadgeIcon;
  imageUrl: string | null;
  secret: boolean;
  /** Secret and not earned: name/description/tiers are hidden ("?"). */
  hidden: boolean;
  status: BadgeStatus;
  window: { start: string; end: string } | null;
  tiers: BadgeTierView[];
  /** Highest tier reached (0 = none yet). */
  tier: number;
  /** Progress toward the next tier: current value and that tier's threshold (null when maxed/hidden). */
  progress: { value: number; target: number; label: string } | null;
  earnedAt: string | null;
  /** Only on your own catalog: earned but not celebrated yet. */
  unseen?: boolean;
}

export interface BadgeCatalogResponse {
  user: PublicUser;
  level: LevelInfo;
  /** Up to 3 badge keys pinned to the profile. */
  showcase: string[];
  badges: BadgeView[];
  earnedCount: number;
}

export interface BadgeEarnedEntry {
  tier: number;
  earnedAt: string;
  /** e.g. { challengeId, challengeName } or { date }. */
  context: Record<string, unknown>;
}

export interface BadgeDetailResponse {
  badge: BadgeView;
  history: BadgeEarnedEntry[];
  /** How many of the viewer's friends have it, and everyone on the server. */
  friendsWithIt: number;
  earnedByCount: number;
}

/** The newest badges you earned and haven't seen celebrated yet. */
export interface UnseenBadgesResponse {
  badges: BadgeView[];
  level: LevelInfo;
}

export const showcaseSchema = z.object({ keys: z.array(z.string().max(64)).max(3) });
export const markSeenSchema = z.object({ keys: z.array(z.string().max(64)).max(200) });

/** Feed item when someone earns a gold, platinum, single-tier secret or limited-time badge. */
export interface BadgeFeedPayload {
  key: string;
  name: string;
  tier: number;
  tierName: TierName | null;
  icon: BadgeIcon;
  imageUrl: string | null;
  /** More earned in the same sync, shown as "+2 more". */
  more: number;
}

// ---------- Admin ----------

export interface AdminBadge extends BadgeDraft {
  status: BadgeStatus;
  origin: BadgeOrigin;
  /** Garmin badge id when it came from a suggestion. */
  sourceRef: string | null;
  version: number;
  earnedBy: number;
  updatedAt: string;
  publishedAt: string | null;
}

export interface BadgePreviewResponse {
  /** People who'd have it (any tier) if it went live now. */
  wouldEarn: number;
  byTier: number[];
  sample: { user: PublicUser; tier: number }[];
}

export const SUGGESTION_STATUSES = [
  'pending',
  'matched',
  'skipped',
  'approved',
  'dismissed',
  'failed',
] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

/** A badge from the Garmin badge database (garminbadges.com) and what the LLM made of it. */
export interface BadgeSuggestion {
  id: string;
  status: SuggestionStatus;
  source: {
    ref: string;
    name: string;
    description: string;
    category: string | null;
    start: string | null;
    end: string | null;
    url: string;
  };
  /** The proposed Gauntlet badge (matched only). Original name/wording/icon, never Garmin's. */
  draft: BadgeDraft | null;
  /** Why it was skipped, or why it failed. */
  reason: string | null;
  /** Key of the badge made from it, once approved. */
  badgeKey: string | null;
  createdAt: string;
}

export interface BadgeImportStatus {
  /** Off when ANTHROPIC_API_KEY isn't set. */
  enabled: boolean;
  model: string;
  running: boolean;
  lastRunAt: string | null;
  lastResult: {
    fetched: number;
    added: number;
    matched: number;
    skipped: number;
    failed: number;
    /** Why the run stopped early (Garmin unreachable, API key refused), if it did. */
    error?: string | null;
  } | null;
  counts: Record<SuggestionStatus, number>;
}

export const importRunSchema = z.object({
  /** Re-check suggestions that failed or were skipped, not only new Garmin badges. */
  retry: z.boolean().default(false),
  /** At most this many LLM calls this run. */
  limit: z.number().int().min(1).max(1000).default(1000),
});
