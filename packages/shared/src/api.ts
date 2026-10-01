/**
 * Request schemas and response types for the Gauntlet API, shared by the
 * server (validation) and the clients (typing).
 */
import { z } from 'zod';
import { isDateString } from './dates.js';
import { isMetricKey, type MetricKey } from './metrics.js';
import { SCORING_MODES, type ScoringMode } from './scoring.js';

const dateString = z.string().refine(isDateString, 'Expected a YYYY-MM-DD date');

// ---------- Auth ----------

export const loginPasswordSchema = z.object({
  method: z.literal('password'),
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export const loginApiKeySchema = z.object({
  method: z.literal('api_key'),
  apiKey: z.string().trim().min(32),
});

export const loginSchema = z.discriminatedUnion('method', [loginPasswordSchema, loginApiKeySchema]);
export type LoginRequest = z.infer<typeof loginSchema>;

export const signupSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(60),
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  password: z.string().min(8, 'Use at least 8 characters').max(128),
});
export type SignupRequest = z.infer<typeof signupSchema>;

export const twoFactorSchema = z.object({
  ticket: z.string().min(1),
  code: z.string().trim().min(4).max(12),
  method: z.enum(['totp', 'otp']).default('totp'),
});
export type TwoFactorRequest = z.infer<typeof twoFactorSchema>;

export type LoginResponse =
  | { status: 'ok'; accessToken: string; refreshToken?: string; user: MeUser }
  | { status: 'two_factor'; ticket: string };

export interface RefreshResponse {
  accessToken: string;
  refreshToken?: string;
}

// ---------- Users ----------

export interface PublicUser {
  id: string;
  displayName: string;
  initials: string;
}

export interface MeUser extends PublicUser {
  email: string;
  timezone: string;
  settings: UserSettings;
  sparkyKeyStatus: 'active' | 'invalid' | 'revoked';
}

export interface UserSettings {
  shareWorkoutDetails: boolean;
  healthConnectSync: boolean;
}

export const updateMeSchema = z.object({
  displayName: z.string().trim().min(1).max(40).optional(),
  timezone: z.string().min(1).max(64).optional(),
  settings: z
    .object({
      shareWorkoutDetails: z.boolean().optional(),
      healthConnectSync: z.boolean().optional(),
    })
    .optional(),
});

// ---------- Friends ----------

export interface Friend extends PublicUser {
  lastSyncedAt: string | null;
  /** Short status line such as "Running · Weekend 100K". */
  status: string | null;
  /** Rank in a shared active challenge, if any. */
  sharedRank: number | null;
  online: boolean;
}

export interface FriendRequest {
  id: string;
  user: PublicUser;
  direction: 'incoming' | 'outgoing';
  createdAt: string;
}

export interface FriendsResponse {
  friends: Friend[];
  requests: FriendRequest[];
}

export const friendRequestSchema = z.object({ email: z.string().trim().email() });

// ---------- Invites ----------

export const createInviteSchema = z.object({
  kind: z.enum(['friend', 'challenge']),
  challengeId: z.string().uuid().optional(),
});

export interface Invite {
  code: string;
  kind: 'friend' | 'challenge';
  url: string;
  expiresAt: string;
}

export interface InvitePreview {
  code: string;
  kind: 'friend' | 'challenge';
  from: PublicUser;
  challenge?: { id: string; name: string; metricLabel: string; startDate: string; endDate: string };
}

// ---------- Challenges ----------

const metricKey = z
  .string()
  .refine(isMetricKey, 'Unknown metric') as unknown as z.ZodType<MetricKey>;

export const createChallengeSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    metric: metricKey,
    custom: z
      .object({
        categoryId: z.string().min(1),
        label: z.string().min(1).max(40),
        unit: z.string().max(12).optional(),
        aggregate: z.enum(['sum', 'avg']),
        lowerIsBetter: z.boolean(),
      })
      .optional(),
    scoring: z.enum(SCORING_MODES),
    goal: z.number().positive().nullable().optional(),
    startDate: dateString,
    endDate: dateString,
    timezone: z.string().min(1).max(64),
    inviteUserIds: z.array(z.string().uuid()).max(50).default([]),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: 'End date must be on or after start date',
    path: ['endDate'],
  })
  .refine((v) => !v.metric.startsWith('custom:') || v.custom, {
    message: 'Custom metrics need options',
    path: ['custom'],
  });
export type CreateChallengeRequest = z.input<typeof createChallengeSchema>;

export type ChallengeStatus = 'upcoming' | 'active' | 'completed';
export type ParticipantState = 'invited' | 'joined' | 'declined';

export interface ChallengeSummary {
  id: string;
  name: string;
  metric: MetricKey;
  metricLabel: string;
  unit: string;
  decimals: number;
  scoring: ScoringMode;
  goal: number | null;
  startDate: string;
  endDate: string;
  timezone: string;
  status: ChallengeStatus;
  participantCount: number;
  myState: ParticipantState | null;
  myRank: number | null;
  myScore: number | null;
  leader: { user: PublicUser; score: number | null } | null;
  /** Gap to the person directly ahead of me (positive), or to the next behind if I lead. */
  gap: { user: PublicUser; amount: number; ahead: boolean } | null;
  daysLeft: number;
  createdBy: string;
}

export interface StandingRow {
  user: PublicUser;
  rank: number;
  score: number | null;
  progress: number | null;
  reachedGoalOn: string | null;
  todayValue: number | null;
  state: ParticipantState;
  lastSyncedAt: string | null;
  isMe: boolean;
}

export interface ChallengeDetail extends ChallengeSummary {
  lowerIsBetter: boolean;
  aggregate: 'sum' | 'avg';
  standings: StandingRow[];
  invited: PublicUser[];
  rematchOf: string | null;
}

export interface ChallengeResult {
  challenge: ChallengeDetail;
  me: {
    rank: number | null;
    score: number | null;
    bestDay: number | null;
    daysWithData: number;
  } | null;
  winner: PublicUser | null;
}

export const respondChallengeSchema = z.object({ accept: z.boolean() });

// ---------- Feed ----------

export type FeedEventKind =
  'progress' | 'took_lead' | 'goal_reached' | 'challenge_won' | 'joined' | 'challenge_created';

export interface FeedEvent {
  id: string;
  kind: FeedEventKind;
  actor: PublicUser;
  challenge: { id: string; name: string } | null;
  text: string;
  /** Short value badge such as "+10.2". */
  badge: string | null;
  source: string | null;
  createdAt: string;
}

// ---------- Today / trends ----------

export interface TodayResponse {
  date: string;
  lastSyncedAt: string | null;
  metrics: {
    key: MetricKey;
    label: string;
    value: number | null;
    unit: string;
    goal: number | null;
  }[];
  featured: ChallengeSummary | null;
}

export const trendsQuerySchema = z.object({
  range: z.enum(['day', 'week', 'month']).default('week'),
  metric: metricKey.default('steps' as MetricKey),
});

export interface TrendsResponse {
  metric: MetricKey;
  range: 'day' | 'week' | 'month';
  total: number;
  previousTotal: number;
  changePct: number | null;
  bars: { date: string; label: string; value: number; isToday: boolean }[];
  rankHistory: {
    challengeId: string;
    name: string;
    points: { date: string; rank: number }[];
  } | null;
  personalBests: { label: string; value: string }[];
}

// ---------- Sources ----------

export interface SourcesResponse {
  sparkyUrl: string;
  providers: { source: string; label: string; records: number }[];
  integrationsUrl: string;
}

// ---------- Garmin Connect (linked inside SparkyFitness) ----------

export interface GarminStatus {
  linked: boolean;
  lastUpdated: string | null;
  tokenExpiresAt: string | null;
}

export const garminLoginSchema = z.object({
  email: z.string().trim().min(1, 'Enter your Garmin email').max(200),
  password: z.string().min(1, 'Enter your Garmin password').max(200),
});
export type GarminLoginRequest = z.infer<typeof garminLoginSchema>;

export const garminMfaSchema = z.object({
  clientState: z.string().min(1).max(200),
  code: z.string().trim().min(4, 'Enter the code Garmin sent you').max(10),
});
export type GarminMfaRequest = z.infer<typeof garminMfaSchema>;

export type GarminLoginResult =
  { status: 'connected' } | { status: 'needs_mfa'; clientState: string };

export const ingestSchema = z.object({
  records: z.array(z.record(z.string(), z.unknown())).min(1).max(5000),
});

export interface CustomMetricOption {
  categoryId: string;
  label: string;
  unit: string | null;
}

export interface ApiError {
  error: string;
  code?: string;
}

/** Latest published Android build, served by the API when hosting is enabled. */
export interface AndroidRelease {
  version: string;
  builtAt: string;
  sha256: string;
  file: string;
  sizeBytes: number;
  url: string;
  latestUrl: string;
}
