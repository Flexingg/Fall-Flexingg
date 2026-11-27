/**
 * Request schemas and response types for the Gauntlet API, shared by the
 * server (validation) and the clients (typing).
 */
import { z } from 'zod';
import { isDateString } from './dates.js';
import type { ClockFormat, UnitSystem } from './format.js';
import { isMetricKey, type MetricAggregate, type MetricGroup, type MetricKey } from './metrics.js';
import { isTrendMetric } from './derive.js';
import { soloConfigSchema, type SoloConfig, type SoloProgress } from './solo.js';
import { SCORING_MODES, type ScoringMode } from './scoring.js';
import { recurrenceSchema, type Reaction, type Recurrence } from './notify.js';
import { teamsInputSchema, type ChallengeTeam, type TeamScoring } from './teams.js';
import type { SeriesInfo } from './recurring.js';
import { stakeSchema, type RematchSeries, type StakeInfo } from './stakes.js';

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
  /** Badge level (everyone can see it); absent where the server didn't look it up. */
  level?: number;
}

export type Visibility = 'private' | 'public';

export interface MeUser extends PublicUser {
  email: string;
  timezone: string;
  settings: UserSettings;
  sparkyKeyStatus: 'active' | 'invalid' | 'revoked';
  /** private (default): only friends and challenge-mates see you. public: searchable, can join public challenges. */
  visibility: Visibility;
  handle: string | null;
  /** Server admin: can feature public challenges. */
  isAdmin: boolean;
  /** The built-in demo account: sample data, nothing connected, can't be deleted. */
  demo: boolean;
}

/** 3-20 lowercase letters, digits or underscores. */
export const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

/** What anyone may see about a public user (never email or health data). */
export interface UserCard extends PublicUser {
  handle: string | null;
  /** Challenges finished and won. */
  challenges: { played: number; won: number };
  /** My relationship with them. */
  friendship: 'none' | 'friends' | 'outgoing' | 'incoming' | 'me';
}

export const userSearchSchema = z.object({ q: z.string().trim().min(2).max(40) });

export interface UserSettings {
  shareWorkoutDetails: boolean;
  /** Show my workouts to the other people in challenges that have Show Events on. */
  shareEvents: boolean;
  healthConnectSync: boolean;
  /** Show my trophies, milestones and all-time stats to people who can see my profile. */
  shareProfileStats: boolean;
  /** How values are written: null until the person (or their device) picks; see format.ts. */
  units: UnitSystem | null;
  clock: ClockFormat | null;
  /** Number format (digit grouping, decimal mark) as a locale tag such as "de-DE". */
  locale: string | null;
}

export const updateMeSchema = z.object({
  displayName: z.string().trim().min(1).max(40).optional(),
  timezone: z.string().min(1).max(64).optional(),
  settings: z
    .object({
      shareWorkoutDetails: z.boolean().optional(),
      shareEvents: z.boolean().optional(),
      shareProfileStats: z.boolean().optional(),
      healthConnectSync: z.boolean().optional(),
      units: z.enum(['metric', 'imperial']).optional(),
      clock: z.enum(['12h', '24h']).optional(),
      locale: z.string().min(2).max(35).optional(),
    })
    .optional(),
  visibility: z.enum(['private', 'public']).optional(),
  handle: z
    .string()
    .trim()
    .toLowerCase()
    .transform((v) => v.replace(/^@/, ''))
    .refine((v) => v === '' || HANDLE_RE.test(v), 'Use 3-20 letters, numbers or _')
    .nullable()
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

export const friendRequestSchema = z.union([
  z.object({ email: z.string().trim().email() }),
  z.object({ userId: z.string().uuid() }),
]);

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
  challenge?: {
    id: string;
    name: string;
    metricLabel: string;
    startDate: string;
    endDate: string;
    showEvents: boolean;
    /** The side bet, if the challenge has one. */
    stake?: string | null;
  };
}

// ---------- Challenges ----------

const metricKey = z
  .string()
  .refine(isMetricKey, 'Unknown metric') as unknown as z.ZodType<MetricKey>;

/** What each person picks when joining a weight challenge. Their weights stay private. */
export const weightGoalParamsSchema = z
  .object({
    direction: z.enum(['lose', 'gain']),
    targetType: z.enum(['percent', 'kg']),
    target: z.number().positive(),
  })
  .refine((p) => (p.targetType === 'percent' ? p.target <= 30 : p.target <= 60), {
    message: 'Pick a realistic target (at most 30% or 60 kg)',
    path: ['target'],
  });

/** Settings a participant brings to a challenge (only weight challenges use them today). */
export const participantParamsSchema = z.object({ weightGoal: weightGoalParamsSchema.optional() });
export type ParticipantParams = z.infer<typeof participantParamsSchema>;

export const joinChallengeSchema = z.object({
  params: participantParamsSchema.optional(),
  /** Required to join a team challenge (switching is allowed until it starts). */
  teamId: z.string().uuid().optional(),
});

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
    /** public: listed in Discover so anyone public can join. */
    visibility: z.enum(['private', 'public']).default('private'),
    /** The creator's own settings (e.g. their weight target). */
    params: participantParamsSchema.optional(),
    /** Participants can open the workouts, sets and fasts that count. */
    showEvents: z.boolean().default(false),
    /** A challenge against yourself: the kind and its extras. Goal and dates work as usual. */
    solo: soloConfigSchema.optional(),
    /** Split people into 2-6 teams. Not for solo challenges. */
    teams: teamsInputSchema.optional(),
    /** Start a new round when this one ends. Not for solo challenges. */
    recurrence: recurrenceSchema.optional(),
    /** A plain-text side bet, e.g. "Loser buys coffee". Not for solo challenges. */
    stake: stakeSchema.optional(),
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
  visibility: Visibility;
  featured: boolean;
  showEvents: boolean;
  /** Set for a challenge against yourself: how you are doing against your own goal. */
  solo: SoloProgress | null;
  /** Set when the challenge repeats (until the creator stops it). */
  recurrence?: Recurrence | null;
  /** Which round of a recurring series this is. */
  seriesRound?: number | null;
  /** Set for team challenges: how a team's score is worked out. */
  teamScoring?: TeamScoring | null;
  /** The plain-text side bet, if any. */
  stake?: string | null;
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
  /** Team in a team challenge. */
  teamId?: string | null;
}

export interface ChallengeDetail extends ChallengeSummary {
  /** The viewer's own settings in this challenge (e.g. their weight target). */
  myParams: ParticipantParams | null;
  /** The kind of solo challenge and its extras, when it is one. */
  soloConfig: SoloConfig | null;
  lowerIsBetter: boolean;
  aggregate: MetricAggregate;
  standings: StandingRow[];
  invited: PublicUser[];
  rematchOf: string | null;
  /** Team leaderboard (best first); null when the challenge has no teams. */
  teams?: ChallengeTeam[] | null;
  /** The team the viewer is on, or was suggested if invited. */
  myTeamId?: string | null;
  /** Round number, earlier rounds and the season table, for a recurring series. */
  series?: SeriesInfo | null;
  /** Who owes the side bet and whether it is settled; set once a challenge with a side bet is over. */
  stakeInfo?: StakeInfo | null;
  /** Wins per person across a chain of rematches; set when the challenge is part of one. */
  rematchSeries?: RematchSeries | null;
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

/**
 * What the creator can change after a challenge exists. Dates are fixed at creation (scores
 * can't be shifted under people), so sending them is refused; Rematch runs it again.
 */
export const DATES_FIXED_MESSAGE =
  "Dates can't be changed after a challenge is created. Use Rematch to run it again.";
export const updateChallengeSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    visibility: z.enum(['private', 'public']).optional(),
    showEvents: z.boolean().optional(),
    /** Null stops a recurring challenge from starting another round. */
    recurrence: recurrenceSchema.nullable().optional(),
    /** Null removes the side bet. Only before the challenge starts. */
    stake: stakeSchema.optional(),
  })
  .strict();
export type UpdateChallengeRequest = z.input<typeof updateChallengeSchema>;

/** Everyone's score at the end of each day, for the line graph on the challenge page. */
export interface ChallengeProgress {
  dates: string[];
  series: { user: PublicUser; rank: number; isMe: boolean; values: (number | null)[] }[];
  lowerIsBetter: boolean;
  /** A goal line to draw (solo challenges), and how to read the values. */
  target: number | null;
  valueKind: 'metric' | 'pct' | 'days';
  /** More people are in the challenge than are drawn (top ranked plus the viewer). */
  truncated: boolean;
  total: number;
}

// ---------- Show Events ("what counted") ----------

export type ChallengeEventKind = 'workout' | 'lift' | 'fast' | 'day';

/** One thing that counted toward a score, read from SparkyFitness when someone looks. */
export interface ChallengeEvent {
  id: string;
  kind: ChallengeEventKind;
  /** "Run", "Squat", "Fast", or the metric for a day total. */
  title: string;
  /** "40 min · 450 kcal". */
  detail: string;
  source: string | null;
  /** Workouts and lift sessions: the id that opens `/workouts/:id` (see WorkoutSummary). */
  workoutId?: string | null;
}

export interface EventGroup {
  user: PublicUser;
  isMe: boolean;
  /** hidden: they keep their workouts private. unavailable: SparkyFitness couldn't be reached. */
  status: 'ok' | 'hidden' | 'unavailable';
  events: ChallengeEvent[];
}

export interface ChallengeEventsResponse {
  date: string;
  groups: EventGroup[];
  /** Participants not included because the request was capped (ask for them by userId). */
  more: number;
}

export const eventsQuerySchema = z.object({
  date: dateString,
  userId: z.string().uuid().optional(),
});

export const respondChallengeSchema = z.object({
  accept: z.boolean(),
  params: participantParamsSchema.optional(),
  /** Required when accepting a team challenge (unless a team was suggested). */
  teamId: z.string().uuid().optional(),
});

export const featureChallengeSchema = z.object({ featured: z.boolean() });

export interface DiscoverResponse {
  challenges: ChallengeSummary[];
  /** False while the viewer is private: they can look but not join. */
  canJoin: boolean;
}

// ---------- Feed ----------

export type FeedEventKind =
  | 'progress'
  | 'took_lead'
  | 'goal_reached'
  | 'challenge_won'
  | 'joined'
  | 'challenge_created'
  | 'personal_record';

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
  /** Emoji people left on it (only those used at least once). Absent where reactions don't exist. */
  reactions?: { emoji: Reaction; count: number; mine: boolean }[];
  commentCount?: number;
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
  /**
   * False when nothing feeds this account yet (no data in the last 30 days, no linked app, no
   * Health Connect): the app nudges the person to connect a source.
   */
  hasSources: boolean;
}

/** One quantity the live wallpaper draws: today's value and the person's own target. */
export interface WallpaperChannel {
  value: number | null;
  goal: number | null;
}

/** Today's nutrition, water and lifting for the Android live wallpaper (no challenge data). */
export interface WallpaperResponse {
  date: string;
  /** The day boundary `date` was taken in, so the phone can tell when it's a new day. */
  timezone: string;
  calories: WallpaperChannel;
  protein: WallpaperChannel;
  carbs: WallpaperChannel;
  fat: WallpaperChannel;
  /** Litres. */
  water: WallpaperChannel;
  /** Kilograms lifted; the goal is the best same-weekday day of the last 8 weeks. */
  volume: WallpaperChannel;
  volumeGoalSource: 'best_weekday' | 'default';
}

export const trendsQuerySchema = z.object({
  range: z.enum(['day', 'week', 'month']).default('week'),
  metric: z.string().refine(isTrendMetric, 'Unknown metric').default('steps'),
});

/** How a metric is shown on Trends: label, unit and how days combine over the range. */
export interface TrendDefInfo {
  key: string;
  label: string;
  unit: string;
  decimals: number;
  /** sum: added up. avg: average of days. max: best day. last: latest value (weight). */
  aggregate: 'sum' | 'avg' | 'max' | 'last';
  group: MetricGroup;
}

export interface TrendOverviewItem extends TrendDefInfo {
  total: number;
  previousTotal: number;
  changePct: number | null;
}

export interface TrendsOverview {
  range: 'day' | 'week' | 'month';
  /** Stats with data in this range or the one before it. */
  items: TrendOverviewItem[];
  /** Every stat the person has any data for (to pick from). */
  available: Pick<TrendDefInfo, 'key' | 'label' | 'unit' | 'group'>[];
}

export interface TrendsResponse {
  metric: string;
  def: TrendDefInfo;
  range: 'day' | 'week' | 'month';
  total: number;
  previousTotal: number;
  changePct: number | null;
  bars: { date: string; label: string; value: number; isToday: boolean }[];
  /** The period before, one entry per bar in the same order (same day of the period), for Compare. */
  previousBars?: { date: string; value: number }[];
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

// ---------- Connections (devices and apps linked inside SparkyFitness) ----------

export const PROVIDER_IDS = [
  'garmin',
  'strava',
  'fitbit',
  'oura',
  'polar',
  'coros',
  'hevy',
  'liftosaur',
  'wger',
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export const isProviderId = (v: unknown): v is ProviderId =>
  typeof v === 'string' && (PROVIDER_IDS as readonly string[]).includes(v);

/** login: email + password (Garmin). oauth: sign in on the provider's site. api_key: paste a key. library: just switch it on. */
export type ConnectKind = 'login' | 'oauth' | 'api_key' | 'library';

export interface ConnectionInfo {
  id: ProviderId;
  label: string;
  blurb: string;
  kind: ConnectKind;
  state: 'connected' | 'disconnected' | 'unavailable';
  /** For "unavailable": why, and what to do. Otherwise a short status line, if any. */
  note: string | null;
  lastSyncAt: string | null;
  /** Where to finish in SparkyFitness when this app can't (OAuth without a Gauntlet server). */
  settingsUrl: string | null;
}

export interface ConnectionsResponse {
  connections: ConnectionInfo[];
}

export const connectBodySchema = z.object({
  apiKey: z.string().trim().min(8, 'Paste the API key').max(500).optional(),
});
export type ConnectBody = z.infer<typeof connectBodySchema>;

export const oauthCallbackSchema = z.object({
  code: z.string().min(1).max(2000),
  state: z.string().max(2000).optional(),
});
export type OAuthCallbackBody = z.infer<typeof oauthCallbackSchema>;

export type ConnectResult = { status: 'connected' } | { status: 'redirect'; url: string };

export const ingestSchema = z.object({
  records: z.array(z.record(z.string(), z.unknown())).min(1).max(5000),
});

/** An exercise the person has logged weighted sets for, for per-exercise strength challenges. */
export interface LiftOption {
  /** Lower-case name used in the metric key, e.g. "bench press". */
  key: string;
  label: string;
  sessions: number;
}

export interface FastStatus {
  active: { id: string; startedAt: string; targetEndAt: string | null } | null;
}

export const startFastSchema = z.object({ hours: z.number().min(1).max(168) });

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

/** Metrics more than one source can report, where a person picks which one counts. */
export const PRIORITY_METRIC_KEYS = [
  'steps',
  'distance',
  'active_calories',
  'active_minutes',
  'sleep',
  'resting_hr',
] as const;

export interface SourceChoice {
  key: string;
  label: string;
}

export interface SourcePriorityResponse {
  metrics: {
    key: (typeof PRIORITY_METRIC_KEYS)[number];
    label: string;
    /** Sources seen for this metric recently (plus the preferred one, if it has gone quiet). */
    sources: SourceChoice[];
    /** Null: automatic (the highest single source each day). */
    preferred: string | null;
  }[];
}

export const setSourcePrioritySchema = z.object({
  metric: z.enum(PRIORITY_METRIC_KEYS),
  /** A source key, or null for automatic. */
  preferred: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_-]+$/)
    .nullable(),
});

export const syncRequestSchema = z
  .object({
    /** Also ask each connected app (Garmin, Fitbit, ...) to pull its latest data. */
    providers: z.boolean().optional(),
  })
  .default({});

export interface SyncResponse {
  ok: boolean;
  changed: number;
  error?: string;
  /** Apps asked to pull their latest data; their numbers arrive over the next minute or so. */
  pulling: string[];
}
