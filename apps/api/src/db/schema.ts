import type { SoloConfig } from '@gauntlet/shared';
import { sql } from 'drizzle-orm';
import type { NotificationPrefs, Recurrence } from '@gauntlet/shared';
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  uniqueIndex,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  sparkyUserId: text('sparky_user_id').notNull().unique(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  /** AES-GCM encrypted SparkyFitness API key. */
  sparkyKeyEnc: text('sparky_key_enc'),
  /** Id of the key in SparkyFitness, when Gauntlet created it (so it can be deleted). */
  sparkyKeyId: text('sparky_key_id'),
  keyStatus: text('key_status', { enum: ['active', 'invalid', 'revoked'] })
    .notNull()
    .default('active'),
  shareWorkoutDetails: boolean('share_workout_details').notNull().default(true),
  /** Other participants can see this person's workouts in challenges that have Show Events on. */
  shareEvents: boolean('share_events').notNull().default(true),
  healthConnectSync: boolean('health_connect_sync').notNull().default(false),
  /** Show my trophies, milestones and all-time stats to people who can see my profile. */
  shareProfileStats: boolean('share_profile_stats').notNull().default(false),
  /** Preferred sources per metric (source keys, most preferred first), e.g. { steps: ['garmin'] }. */
  sourcePriorities: jsonb('source_priorities')
    .$type<Record<string, string[]>>()
    .notNull()
    .default({}),
  /** Sources the last sync saw per metric, so the app only offers real choices. */
  seenSources: jsonb('seen_sources').$type<Record<string, string[]>>().notNull().default({}),
  /** public: findable by name/handle and can join public challenges. */
  visibility: text('visibility', { enum: ['private', 'public'] })
    .notNull()
    .default('private'),
  /** Optional unique @handle (lowercase) for search and profile links. */
  handle: text('handle').unique(),
  /** The built-in demo account and its made-up friends: sample data, no SparkyFitness behind it. */
  isDemo: boolean('is_demo').notNull().default(false),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  /** The last sync's failure, for the admin page; cleared by the next good sync. */
  lastSyncError: text('last_sync_error'),
  lastSyncErrorAt: timestamp('last_sync_error_at', { withTimezone: true }),
  /** Which notifications this person wants, per kind (missing = the kind's default). */
  notificationPrefs: jsonb('notification_prefs').$type<NotificationPrefs>().notNull().default({}),
  /** ISO week (e.g. 2026-W48) of the last weekly recap sent, so each goes out once. */
  lastRecapWeek: text('last_recap_week'),
  createdAt: createdAt(),
});

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /**
     * When it was exchanged for a new one. It stays usable for a few seconds after, because a page
     * reload can cut off the response carrying its replacement.
     */
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('refresh_tokens_user_idx').on(t.userId)],
);

/** Half-finished logins waiting for a 2FA code. Holds SparkyFitness' 2FA cookie, encrypted. */
export const pendingLogins = pgTable('pending_logins', {
  ticketHash: text('ticket_hash').primaryKey(),
  cookieEnc: text('cookie_enc').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

/** One row per pair, stored with user_low < user_high. */
export const friendships = pgTable(
  'friendships',
  {
    userLow: uuid('user_low')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userHigh: uuid('user_high')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['pending', 'accepted'] }).notNull(),
    createdAt: createdAt(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.userLow, t.userHigh] }),
    index('friendships_high_idx').on(t.userHigh),
  ],
);

export const challenges = pgTable(
  'challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    metric: text('metric').notNull(),
    customLabel: text('custom_label'),
    customUnit: text('custom_unit'),
    aggregate: text('aggregate', { enum: ['sum', 'avg', 'last'] }).notNull(),
    lowerIsBetter: boolean('lower_is_better').notNull().default(false),
    scoring: text('scoring', {
      enum: ['total', 'race_to_goal', 'daily_avg', 'best_day', 'streak'],
    }).notNull(),
    goal: doublePrecision('goal'),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull(),
    timezone: text('timezone').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rematchOf: uuid('rematch_of'),
    /** public: listed in Discover, and public users can join without an invite. */
    visibility: text('visibility', { enum: ['private', 'public'] })
      .notNull()
      .default('private'),
    /** Pinned to the top of Discover by a server admin. */
    featured: boolean('featured').notNull().default(false),
    maxParticipants: integer('max_participants').notNull().default(500),
    /** Participants can open the workouts, sets and fasts that count (read live from SparkyFitness). */
    showEvents: boolean('show_events').notNull().default(false),
    /** Set for a challenge against yourself (one participant): which kind and its extras. */
    solo: jsonb('solo').$type<SoloConfig>(),
    leaderId: uuid('leader_id'),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    /** Team challenge: how a team's score combines its members' scores. Null = everyone for themselves. */
    teamScoring: text('team_scoring', { enum: ['sum', 'avg'] }),
    /** Recurring challenge: starts the next round when this one ends. */
    recurrence: jsonb('recurrence').$type<Recurrence>(),
    /** The first challenge of a recurring series (its own id for the first round). */
    seriesId: uuid('series_id'),
    /** 1 for the first round of a series. */
    seriesRound: integer('series_round'),
    createdAt: createdAt(),
  },
  (t) => [index('challenges_visibility_idx').on(t.visibility, t.endDate)],
);

export const challengeParticipants = pgTable(
  'challenge_participants',
  {
    challengeId: uuid('challenge_id')
      .notNull()
      .references(() => challenges.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    state: text('state', { enum: ['invited', 'joined', 'declined'] }).notNull(),
    invitedBy: uuid('invited_by'),
    finalRank: integer('final_rank'),
    finalScore: doublePrecision('final_score'),
    /** Per-person settings, e.g. a weight challenge's direction and target. */
    params: jsonb('params').$type<Record<string, unknown>>(),
    /** Team in a team challenge. */
    teamId: uuid('team_id'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.challengeId, t.userId] }),
    index('participants_user_idx').on(t.userId),
  ],
);

export const invites = pgTable('invites', {
  code: text('code').primaryKey(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['friend', 'challenge'] }).notNull(),
  challengeId: uuid('challenge_id').references(() => challenges.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

/**
 * One normalised value per user, day and metric. A cache of SparkyFitness data:
 * it can be dropped and rebuilt by syncing.
 */
export const dailyMetrics = pgTable(
  'daily_metrics',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    date: date('date', { mode: 'string' }).notNull(),
    metric: text('metric').notNull(),
    value: doublePrecision('value').notNull(),
    source: text('source'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.date, t.metric] })],
);

export const rankSnapshots = pgTable(
  'rank_snapshots',
  {
    challengeId: uuid('challenge_id')
      .notNull()
      .references(() => challenges.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    date: date('date', { mode: 'string' }).notNull(),
    rank: integer('rank').notNull(),
  },
  (t) => [primaryKey({ columns: [t.challengeId, t.userId, t.date] })],
);

export const feedEvents = pgTable(
  'feed_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    challengeId: uuid('challenge_id').references(() => challenges.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index('feed_actor_idx').on(t.actorId, t.createdAt),
    index('feed_challenge_idx').on(t.challengeId, t.createdAt),
  ],
);

// ---------- Team challenges ----------

export const challengeTeams = pgTable(
  'challenge_teams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    challengeId: uuid('challenge_id')
      .notNull()
      .references(() => challenges.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Display colour, e.g. "#c6ff00". */
    color: text('color').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('teams_challenge_idx').on(t.challengeId)],
);

// ---------- Feed reactions, comments and nudges ----------

export const feedReactions = pgTable(
  'feed_reactions',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => feedEvents.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** One of a small fixed set (see REACTIONS in @gauntlet/shared). */
    emoji: text('emoji').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.userId, t.emoji] })],
);

export const feedComments = pgTable(
  'feed_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => feedEvents.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('comments_event_idx').on(t.eventId, t.createdAt)],
);

export const nudges = pgTable(
  'nudges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromUserId: uuid('from_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toUserId: uuid('to_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    challengeId: uuid('challenge_id').references(() => challenges.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [index('nudges_pair_idx').on(t.fromUserId, t.toUserId, t.createdAt)],
);

// ---------- Notifications and push ----------

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** A NotificationKind from @gauntlet/shared. */
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** In-app path to open, e.g. "/c/<id>". */
    url: text('url'),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    readAt: timestamp('read_at', { withTimezone: true }),
    /** When delivery (web push / device poll) handed it on; null = not yet. */
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.createdAt)],
);

export const pushTargets = pgTable(
  'push_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** webpush: a browser's Push API subscription. device: the Android app polling with a token. */
    kind: text('kind', { enum: ['webpush', 'device'] }).notNull(),
    /** webpush: the subscription endpoint. device: SHA-256 of the device token. */
    endpoint: text('endpoint').notNull(),
    /** webpush: { p256dh, auth }. */
    keys: jsonb('keys').$type<Record<string, string>>(),
    label: text('label'),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('push_endpoint_idx').on(t.endpoint)],
);

// ---------- Personal records ----------

export const personalRecords = pgTable(
  'personal_records',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** e.g. "steps_day", "distance_day", "lift_e1rm:squat", "step_streak". */
    key: text('key').notNull(),
    value: doublePrecision('value').notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);
