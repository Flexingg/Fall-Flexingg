import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
  keyStatus: text('key_status', { enum: ['active', 'invalid', 'revoked'] }).notNull().default('active'),
  shareWorkoutDetails: boolean('share_workout_details').notNull().default(true),
  healthConnectSync: boolean('health_connect_sync').notNull().default(false),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
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
    userLow: uuid('user_low').notNull().references(() => users.id, { onDelete: 'cascade' }),
    userHigh: uuid('user_high').notNull().references(() => users.id, { onDelete: 'cascade' }),
    requestedBy: uuid('requested_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['pending', 'accepted'] }).notNull(),
    createdAt: createdAt(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.userLow, t.userHigh] }), index('friendships_high_idx').on(t.userHigh)],
);

export const challenges = pgTable('challenges', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  metric: text('metric').notNull(),
  customLabel: text('custom_label'),
  customUnit: text('custom_unit'),
  aggregate: text('aggregate', { enum: ['sum', 'avg'] }).notNull(),
  lowerIsBetter: boolean('lower_is_better').notNull().default(false),
  scoring: text('scoring', { enum: ['total', 'race_to_goal', 'daily_avg', 'best_day', 'streak'] }).notNull(),
  goal: doublePrecision('goal'),
  startDate: date('start_date', { mode: 'string' }).notNull(),
  endDate: date('end_date', { mode: 'string' }).notNull(),
  timezone: text('timezone').notNull(),
  createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  rematchOf: uuid('rematch_of'),
  leaderId: uuid('leader_id'),
  finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const challengeParticipants = pgTable(
  'challenge_participants',
  {
    challengeId: uuid('challenge_id').notNull().references(() => challenges.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    state: text('state', { enum: ['invited', 'joined', 'declined'] }).notNull(),
    invitedBy: uuid('invited_by'),
    finalRank: integer('final_rank'),
    finalScore: doublePrecision('final_score'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.challengeId, t.userId] }), index('participants_user_idx').on(t.userId)],
);

export const invites = pgTable('invites', {
  code: text('code').primaryKey(),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
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
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
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
    challengeId: uuid('challenge_id').notNull().references(() => challenges.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    date: date('date', { mode: 'string' }).notNull(),
    rank: integer('rank').notNull(),
  },
  (t) => [primaryKey({ columns: [t.challengeId, t.userId, t.date] })],
);

export const feedEvents = pgTable(
  'feed_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    challengeId: uuid('challenge_id').references(() => challenges.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index('feed_actor_idx').on(t.actorId, t.createdAt), index('feed_challenge_idx').on(t.challengeId, t.createdAt)],
);
