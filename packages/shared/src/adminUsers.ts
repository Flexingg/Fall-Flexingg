/**
 * Shared contract for admin → Accounts and Challenges: the row and detail shapes, the filters, and
 * the one rule for what counts as an "expired" account, so the API and the screens always agree.
 */
import { z } from 'zod';

/** An admin-scheduled deletion waits this long, and any use of the app in that time saves the account. */
export const DELETION_GRACE_DAYS = 30;
/** Sync broken or never worked, and nobody has used the app for this many days → expired. */
export const EXPIRED_QUIET_DAYS = 30;
/** Nobody has used the app for this many days, whatever else is true → expired. */
export const EXPIRED_IDLE_DAYS = 180;
/** "Active" means used the app within this many days. */
export const ACTIVE_DAYS = 30;

/** The rule, in words, for the screens' help text. */
export const EXPIRED_RULE_TEXT =
  `An account is expired when it is not a demo or admin account and either: its SparkyFitness ` +
  `connection is broken and it has not been used for ${EXPIRED_QUIET_DAYS} days; or it never ` +
  `synced any data and has not been used for ${EXPIRED_QUIET_DAYS} days; or it has not been used ` +
  `at all for ${EXPIRED_IDLE_DAYS} days.`;

type When = Date | string | null | undefined;

/** What the expiry rule needs to know about an account. */
export interface AccountFacts {
  isDemo: boolean;
  isAdmin: boolean;
  keyStatus: 'active' | 'invalid' | 'revoked';
  lastSyncedAt: When;
  lastActiveAt: When;
  createdAt: When;
}

const ms = (d: When): number | null => (d ? new Date(d).getTime() : null);

/** Whole days since the account was last used (sign-up counts as the first use). */
export function quietDays(f: Pick<AccountFacts, 'lastActiveAt' | 'createdAt'>, now: Date): number {
  const last = ms(f.lastActiveAt) ?? ms(f.createdAt) ?? now.getTime();
  return Math.max(0, Math.floor((now.getTime() - last) / 86_400_000));
}

/** Why an account is expired, or null when it is not. */
export function expiredReason(f: AccountFacts, now: Date): string | null {
  if (f.isDemo || f.isAdmin) return null;
  const quiet = quietDays(f, now);
  if (quiet >= EXPIRED_IDLE_DAYS) return `Not used for ${EXPIRED_IDLE_DAYS}+ days`;
  if (quiet >= EXPIRED_QUIET_DAYS) {
    if (f.keyStatus !== 'active')
      return `SparkyFitness connection lost and not used for ${quiet} days`;
    if (!f.lastSyncedAt) return `Never synced any data and not used for ${quiet} days`;
  }
  return null;
}

/** When a deletion was scheduled, worked out from the day it is due. */
export const scheduledOn = (deletionAt: Date | string): Date =>
  new Date(new Date(deletionAt).getTime() - DELETION_GRACE_DAYS * 86_400_000);

export const isExpired = (f: AccountFacts, now: Date): boolean => expiredReason(f, now) !== null;

export const ACCOUNT_FILTERS = [
  'all',
  'active',
  'inactive',
  'expired',
  'scheduled',
  'problems',
] as const;
export type AccountFilter = (typeof ACCOUNT_FILTERS)[number];
export const ACCOUNT_FILTER_LABELS: Record<AccountFilter, string> = {
  all: 'All',
  active: 'Active',
  inactive: 'Inactive',
  expired: 'Expired',
  scheduled: 'Scheduled for deletion',
  problems: 'Sync problems',
};

export const ACCOUNT_SORTS = ['recent', 'quiet', 'name', 'newest'] as const;
export type AccountSort = (typeof ACCOUNT_SORTS)[number];

export type AccountTag =
  'demo' | 'admin' | 'active' | 'inactive' | 'expired' | 'scheduled' | 'sync_problem' | 'key_lost';
export const ACCOUNT_TAG_LABELS: Record<AccountTag, string> = {
  demo: 'Demo',
  admin: 'Admin',
  active: 'Active',
  inactive: 'Inactive',
  expired: 'Expired',
  scheduled: 'Scheduled for deletion',
  sync_problem: 'Sync problem',
  key_lost: 'Connection lost',
};

export interface AccountStateFacts extends AccountFacts {
  lastSyncError: string | null;
  deletionScheduledAt: When;
}

/** The tags an account wears in lists. */
export function accountTags(f: AccountStateFacts, now: Date): AccountTag[] {
  const tags: AccountTag[] = [];
  if (f.isDemo) tags.push('demo');
  if (f.isAdmin) tags.push('admin');
  if (f.deletionScheduledAt) tags.push('scheduled');
  if (isExpired(f, now)) tags.push('expired');
  if (!f.isDemo) tags.push(quietDays(f, now) < ACTIVE_DAYS ? 'active' : 'inactive');
  if (f.keyStatus !== 'active') tags.push('key_lost');
  else if (f.lastSyncError) tags.push('sync_problem');
  return tags;
}

export interface AdminUserRow {
  id: string;
  displayName: string;
  initials: string;
  handle: string | null;
  email: string;
  createdAt: string;
  lastActiveAt: string | null;
  lastSyncedAt: string | null;
  keyStatus: 'active' | 'invalid' | 'revoked';
  healthConnectSync: boolean;
  isDemo: boolean;
  isAdmin: boolean;
  level: number;
  challenges: { active: number; finished: number; won: number };
  friends: number;
  deletionScheduledAt: string | null;
  deletionReason: string | null;
  /** Scheduled for deletion, but they have used the app since: the deletion will be called off. */
  activeSinceScheduled: boolean;
  tags: AccountTag[];
  expiredReason: string | null;
}

export interface AdminUsersResponse {
  users: AdminUserRow[];
  /** Rows matching the filter and search (before paging). */
  total: number;
  limit: number;
  offset: number;
  /** How many accounts each filter would show (ignores the search). */
  counts: Record<AccountFilter, number>;
}

export const adminUsersQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  filter: z.enum(ACCOUNT_FILTERS).default('all'),
  sort: z.enum(ACCOUNT_SORTS).default('recent'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export interface AdminUserChallenge {
  id: string;
  name: string;
  status: 'upcoming' | 'active' | 'completed';
  startDate: string;
  endDate: string;
  state: 'invited' | 'joined' | 'declined';
  /** Final place once the challenge is over. */
  rank: number | null;
  createdByThem: boolean;
}

export interface AdminUserDetail extends AdminUserRow {
  timezone: string;
  visibility: 'private' | 'public';
  sharing: { workoutDetails: boolean; events: boolean; profileStats: boolean };
  /** What the last sync saw: how many kinds of data, and which apps they came from. */
  dataSources: { metrics: number; sources: string[] };
  lastSyncError: string | null;
  lastSyncErrorAt: string | null;
  /** Notification types they have changed from the default. */
  notificationPrefsSet: number;
  /** How many places notifications can go (browsers, phones); never the addresses themselves. */
  pushTargets: { webpush: number; device: number };
  recentNotifications: number;
  badges: { earned: number; xp: number };
  challengeList: AdminUserChallenge[];
  friendNames: string[];
}

export const scheduleDeletionSchema = z.object({
  reason: z.string().trim().max(200).optional(),
});
export const deleteAccountSchema = z.object({ confirm: z.string().min(1).max(100) });
export const cleanupSchema = z.object({ dryRun: z.boolean().optional() });

export interface CleanupResult {
  dryRun: boolean;
  /** Accounts that are (dry run) or were just scheduled for deletion. */
  accounts: { id: string; displayName: string; reason: string }[];
}

export interface AdminAuditEntry {
  at: string;
  adminId: string | null;
  adminName: string;
  action:
    | 'schedule_deletion'
    | 'cancel_deletion'
    | 'delete_account'
    | 'cleanup_expired'
    | 'auto_delete'
    | 'auto_keep';
  targetId: string | null;
  targetName: string | null;
  detail: string | null;
}

// ---------- Challenges overview ----------

export const ADMIN_CHALLENGE_STATUSES = ['running', 'upcoming', 'finished', 'all'] as const;
export type AdminChallengeStatus = (typeof ADMIN_CHALLENGE_STATUSES)[number];

export const adminChallengesQuerySchema = z.object({
  status: z.enum(ADMIN_CHALLENGE_STATUSES).default('all'),
  q: z.string().trim().max(100).optional(),
});

export interface AdminChallengeRow {
  id: string;
  name: string;
  metricLabel: string;
  scoring: string;
  startDate: string;
  endDate: string;
  status: 'upcoming' | 'active' | 'completed';
  creator: { id: string; displayName: string } | null;
  joined: number;
  invited: number;
  visibility: 'private' | 'public';
  featured: boolean;
  solo: boolean;
  team: boolean;
  recurring: boolean;
  /** Who is ahead right now (running challenges only). */
  leader: { id: string; displayName: string } | null;
}

export interface AdminChallengesResponse {
  challenges: AdminChallengeRow[];
  counts: Record<'running' | 'upcoming' | 'finished' | 'all', number>;
}

// ---------- Publish all badges ----------

export const publishAllSchema = z.object({
  keys: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/))
    .max(500)
    .optional(),
});

/** Progress of the "award everyone who already qualifies" run after publishing badges. */
export interface BadgeBackfillStatus {
  running: boolean;
  /** Badges finished, and how many in this run. */
  done: number;
  total: number;
  /** The badge being worked on right now. */
  current: string | null;
  updatedAt: string | null;
}
