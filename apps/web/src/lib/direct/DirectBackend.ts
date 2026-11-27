/**
 * Direct mode: the Android app talks to SparkyFitness itself instead of going through a Gauntlet
 * server. It reads the last couple of months, merges them with the same code the server uses, and
 * derives Today and Trends on the phone.
 *
 * Deliberately free of browser/Capacitor imports so it can be unit-tested in Node with a fake server.
 */
import {
  buildDay,
  buildRingsFromRows,
  buildToday,
  DAY_HISTORY_DAYS,
  isDateString,
  ringConfigSchema,
  ringsOf,
  type DayResponse,
  type RingConfig,
  buildTrends,
  buildWallpaper,
  initials,
  personalBests,
  addDays,
  buildOverview,
  todayIn,
  type ConnectionInfo,
  type ConnectResult,
  type GarminLoginResult,
  type GarminStatus,
  displayDefaultsFor,
  resolveDisplay,
  type ProviderId,
  type MeUser,
  type MetricKey,
  type MetricRow,
  type SourcesResponse,
  type TodayResponse,
  type TrendRange,
  type TrendsOverview,
  type TrendsResponse,
  type UserSettings,
  type WallpaperResponse,
} from '@gauntlet/shared';
import {
  connectProvider,
  ConnectionError,
  describeGarminError,
  disconnectProvider,
  keepSynced,
  listConnections,
  syncProvider,
  syncProviderRange,
  describeSources,
  fetchMerged,
  SparkyClient,
  SparkyError,
  type SparkyUser,
} from '@gauntlet/sparky';

export interface KeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string | null): Promise<void>;
}

export interface DirectOptions {
  sparkyUrl: string;
  apiKey: string;
  kv: KeyValue;
  timezone: string;
  /** The device's locale, for the first guess at units and clock when none is saved. */
  locale?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** 'sparky_key_invalid' | 'sparky_unreachable' | 'sparky_error', or a Garmin / linked-app problem code. */
export type DirectErrorCode = string;

export class DirectError extends Error {
  constructor(
    message: string,
    readonly code: DirectErrorCode,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'DirectError';
  }
}

/** Turn a SparkyFitness failure into something the screens can show. */
export function explain(err: unknown, sparkyUrl: string): DirectError {
  if (err instanceof DirectError) return err;
  if (err instanceof SparkyError) {
    if (err.status === 401 || err.status === 403) {
      return new DirectError(
        'SparkyFitness rejected your API key. Create a new one in SparkyFitness under Settings → API keys and sign in again.',
        'sparky_key_invalid',
        err.status,
      );
    }
    if (err.status === 0 || err.status === 503) {
      return new DirectError(
        `Can't reach SparkyFitness at ${sparkyUrl}. Check the address and your connection.`,
        'sparky_unreachable',
        err.status,
      );
    }
    return new DirectError(
      `SparkyFitness answered with an error (${err.status}): ${err.message}`,
      'sparky_error',
      err.status,
    );
  }
  return new DirectError((err as Error)?.message ?? 'Something went wrong', 'sparky_error');
}

/** Like explain(), but a Garmin sign-in problem gets its own plain-words message. */
function explainGarmin(err: unknown, sparkyUrl: string): DirectError {
  if (err instanceof ConnectionError) return new DirectError(err.message, err.code, err.status);
  const problem = describeGarminError(err);
  if (problem) return new DirectError(problem.message, problem.code, problem.status);
  return explain(err, sparkyUrl);
}

const HISTORY_DAYS = 62;
const FRESH_MS = 2 * 60_000;
const ROWS_KEY = 'gauntlet.direct.rows';
const ME_KEY = 'gauntlet.direct.me';
const SETTINGS_KEY = 'gauntlet.direct.settings';
/** The person's Today rings (which stats, which goals), kept on the phone. */
export const RINGS_KEY = 'gauntlet.direct.rings';

interface Cached {
  savedAt: string;
  rows: MetricRow[];
}

export class DirectBackend {
  readonly kind = 'direct' as const;
  private readonly client: SparkyClient;
  private readonly now: () => Date;
  private loading: Promise<Cached> | null = null;

  constructor(private readonly o: DirectOptions) {
    this.client = new SparkyClient({ baseUrl: o.sparkyUrl, fetch: o.fetch });
    this.now = o.now ?? (() => new Date());
  }

  get sparkyUrl() {
    return this.o.sparkyUrl;
  }

  /** Confirms the key works. Used by the sign-in screen's connection test. */
  async check(): Promise<SparkyUser> {
    try {
      return await this.client.currentUser(this.o.apiKey);
    } catch (err) {
      throw explain(err, this.o.sparkyUrl);
    }
  }

  async me(): Promise<MeUser> {
    let user: SparkyUser | null = null;
    try {
      user = await this.client.currentUser(this.o.apiKey);
    } catch (err) {
      const e = explain(err, this.o.sparkyUrl);
      if (e.code === 'sparky_key_invalid') throw e;
      // Offline: fall back to the last profile we saw.
      const cached = await this.o.kv.get(ME_KEY);
      if (cached) return { ...(JSON.parse(cached) as MeUser), settings: await this.settings() };
      throw e;
    }
    const displayName = (user.name?.trim() || user.email.split('@')[0] || 'Athlete').slice(0, 40);
    const me: MeUser = {
      id: user.id,
      displayName,
      initials: initials(displayName),
      email: user.email,
      timezone: this.o.timezone,
      settings: await this.settings(),
      sparkyKeyStatus: 'active',
      // Direct mode has no Gauntlet server, so there's no one to be public to.
      visibility: 'private',
      handle: null,
      isAdmin: false,
      demo: false,
      deletionScheduledAt: null,
    };
    await this.o.kv.set(ME_KEY, JSON.stringify(me));
    return me;
  }

  async settings(): Promise<UserSettings> {
    const raw = await this.o.kv.get(SETTINGS_KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<UserSettings>) : {};
    return {
      shareWorkoutDetails: true,
      shareEvents: true,
      healthConnectSync: false,
      shareProfileStats: false,
      units: null,
      clock: null,
      locale: null,
      ...saved,
    };
  }

  async updateSettings(patch: Partial<UserSettings>): Promise<MeUser> {
    await this.o.kv.set(SETTINGS_KEY, JSON.stringify({ ...(await this.settings()), ...patch }));
    return this.me();
  }

  private today_() {
    return todayIn(this.o.timezone, this.now());
  }

  /** Daily values for the last ~2 months. Cached on the phone; falls back to the cache when offline. */
  private async load(force = false): Promise<Cached> {
    const raw = await this.o.kv.get(ROWS_KEY);
    const cached = raw ? (JSON.parse(raw) as Cached) : null;
    if (!force && cached && this.now().getTime() - Date.parse(cached.savedAt) < FRESH_MS)
      return cached;
    this.loading ??= this.refresh().finally(() => (this.loading = null));
    try {
      return await this.loading;
    } catch (err) {
      const e = explain(err, this.o.sparkyUrl);
      if (cached && e.code !== 'sparky_key_invalid') return cached;
      throw e;
    }
  }

  private async refresh(): Promise<Cached> {
    // One day ahead of UTC so people east of it get their "today".
    const end = addDays(todayIn('UTC', this.now()), 1);
    const start = addDays(this.today_(), -HISTORY_DAYS);
    const { merged } = await fetchMerged(this.client, this.o.apiKey, start, end, {
      timezone: this.o.timezone,
      // Everything a challenge can be scored on is on Trends too; goals only for recent days to
      // keep the phone's refresh quick.
      goals: { maxFetches: 14 },
      allCustom: true,
      allLifts: true,
    });
    const fresh: Cached = {
      savedAt: this.now().toISOString(),
      rows: merged.map(({ date, metric, value }) => ({ date, metric, value })),
    };
    await this.o.kv.set(ROWS_KEY, JSON.stringify(fresh));
    return fresh;
  }

  async sync(): Promise<{ ok: true; changed: number }> {
    const before = (await this.o.kv.get(ROWS_KEY)) ?? '';
    const after = await this.load(true);
    return { ok: true, changed: JSON.stringify(after.rows) === before ? 0 : after.rows.length };
  }

  async today(): Promise<TodayResponse> {
    const { rows, savedAt } = await this.load();
    const today = this.today_();
    return {
      ...buildToday(rows, today),
      rings: buildRingsFromRows(await this.rings(), rows, today),
      lastSyncedAt: savedAt,
      featured: null,
      hasSources: await this.hasSources(rows, today),
    };
  }

  async rings(): Promise<RingConfig> {
    const raw = await this.o.kv.get(RINGS_KEY);
    try {
      return ringsOf(raw ? JSON.parse(raw) : null);
    } catch {
      return ringsOf(null);
    }
  }

  async saveRings(config: unknown): Promise<RingConfig> {
    const rings = ringConfigSchema.parse(config) as RingConfig;
    await this.o.kv.set(RINGS_KEY, JSON.stringify(rings));
    return rings;
  }

  /** Every stat for one day from the cached rows (the last couple of months). */
  async day(date?: string): Promise<DayResponse> {
    const { rows } = await this.load();
    const today = this.today_();
    const d = date ?? today;
    if (!isDateString(d) || d > today || d < addDays(today, -DAY_HISTORY_DAYS))
      throw new DirectError('That day is out of range', 'bad_date');
    return buildDay({ rows, date: d, today, config: await this.rings() });
  }

  async wallpaper(): Promise<WallpaperResponse> {
    const { rows } = await this.load();
    return buildWallpaper(rows, this.today_(), this.o.timezone);
  }

  /** Same rule as the server: recent data, Health Connect, or a linked app. */
  private async hasSources(rows: MetricRow[], today: string): Promise<boolean> {
    const since = addDays(today, -30);
    if (rows.some((r) => r.date >= since)) return true;
    if ((await this.settings()).healthConnectSync) return true;
    try {
      return (await this.connections()).some((c) => c.state === 'connected');
    } catch {
      return true;
    }
  }

  async trendsOverview(range: TrendRange): Promise<TrendsOverview> {
    const { rows } = await this.load();
    return buildOverview({ rows, range, today: this.today_() });
  }

  async trends(range: TrendRange, metric: string): Promise<TrendsResponse> {
    const { rows } = await this.load();
    const today = this.today_();
    return {
      ...buildTrends({ rows, range, metric, today }),
      rankHistory: null,
      personalBests: personalBests(rows, {
        today,
        display: resolveDisplay(await this.settings(), displayDefaultsFor(this.o.locale)),
      }),
    };
  }

  async sources(): Promise<SourcesResponse> {
    try {
      return describeSources(this.o.sparkyUrl, await this.client.syncedSources(this.o.apiKey));
    } catch (err) {
      throw explain(err, this.o.sparkyUrl);
    }
  }

  /** Health Connect records go straight into SparkyFitness, tagged the way its own app tags them. */
  async ingest(records: Record<string, unknown>[]): Promise<void> {
    try {
      await this.client.ingestHealthData(
        this.o.apiKey,
        records.map((r) => ({ ...r, source: 'Health Connect' })),
      );
    } catch (err) {
      throw explain(err, this.o.sparkyUrl);
    }
    // Make the next screen reload pick the new data up.
    await this.o.kv.set(ROWS_KEY, null);
  }

  // ---------------------------------------------------------------- Garmin Connect
  // SparkyFitness signs in to Garmin and holds the session; the phone only passes the request on.

  async garminStatus(): Promise<GarminStatus> {
    try {
      return await this.client.garminStatus(this.o.apiKey);
    } catch (err) {
      throw explainGarmin(err, this.o.sparkyUrl);
    }
  }

  async garminLogin(email: string, password: string): Promise<GarminLoginResult> {
    try {
      const result = await this.client.garminLogin(this.o.apiKey, email, password);
      if (result.status === 'connected') {
        void keepSynced(this.client, this.o.apiKey, 'garmin');
        this.garminSyncInBackground(30);
      }
      return result;
    } catch (err) {
      throw explainGarmin(err, this.o.sparkyUrl);
    }
  }

  async garminMfa(clientState: string, code: string): Promise<GarminLoginResult> {
    try {
      const result = await this.client.garminResumeLogin(this.o.apiKey, clientState, code);
      if (result.status === 'connected') {
        void keepSynced(this.client, this.o.apiKey, 'garmin');
        this.garminSyncInBackground(30);
      }
      return result;
    } catch (err) {
      throw explainGarmin(err, this.o.sparkyUrl);
    }
  }

  async garminSync(): Promise<{ ok: true }> {
    const status = await this.garminStatus();
    if (!status.linked) throw new DirectError('Garmin is not connected.', 'garmin_error', 400);
    this.garminSyncInBackground(7);
    return { ok: true };
  }

  async garminDisconnect(): Promise<{ ok: true }> {
    try {
      await this.client.garminUnlink(this.o.apiKey);
    } catch (err) {
      throw explainGarmin(err, this.o.sparkyUrl);
    }
    return { ok: true };
  }

  /** Garmin's pull can take a minute, so it runs on after the screen has moved on. */
  private garminSyncInBackground(days: number) {
    const today = this.today_();
    void this.client
      .garminSync(this.o.apiKey, addDays(today, -days), today)
      .catch(() => undefined)
      .then(() => this.o.kv.set(ROWS_KEY, null));
  }

  // ---------------------------------------------------------------- other apps and devices
  // From the phone alone, apps that sign in on their own website (Strava, Fitbit, ...) can't finish:
  // they need an address the provider can send the person back to. Keys and switches work as usual.

  private connectionsEnv() {
    return {
      sparkyUrl: this.o.sparkyUrl,
      oauthAvailable: false,
      oauth: {},
      now: this.o.now,
    };
  }

  async connections(): Promise<ConnectionInfo[]> {
    try {
      return await listConnections(this.client, this.o.apiKey, this.connectionsEnv());
    } catch (err) {
      throw explainGarmin(err, this.o.sparkyUrl);
    }
  }

  async connect(id: ProviderId, input: { apiKey?: string } = {}): Promise<ConnectResult> {
    try {
      const result = await connectProvider(
        this.client,
        this.o.apiKey,
        id,
        this.connectionsEnv(),
        input,
      );
      if (result.status === 'connected') this.syncInBackground(id, 30);
      return result;
    } catch (err) {
      throw explainGarmin(err, this.o.sparkyUrl);
    }
  }

  async syncApp(id: ProviderId): Promise<{ ok: true }> {
    const all = await this.connections();
    if (all.find((c) => c.id === id)?.state !== 'connected')
      throw new DirectError('That app is not connected.', 'not_connected', 400);
    this.syncInBackground(id, 7);
    return { ok: true };
  }

  async disconnect(id: ProviderId): Promise<{ ok: true }> {
    try {
      await disconnectProvider(this.client, this.o.apiKey, id);
    } catch (err) {
      throw explainGarmin(err, this.o.sparkyUrl);
    }
    return { ok: true };
  }

  /**
   * Ask an app (through SparkyFitness) for one older date range. History import calls this chunk
   * by chunk; Gauntlet's own two-month cache is cleared so it reads again.
   */
  async pullAppRange(
    id: ProviderId,
    start: string,
    end: string,
    opts: { full?: boolean } = {},
  ): Promise<void> {
    try {
      await syncProviderRange(this.client, this.o.apiKey, id, start, end, opts);
    } catch (err) {
      throw explainGarmin(err, this.o.sparkyUrl);
    }
    await this.o.kv.set(ROWS_KEY, null);
  }

  private syncInBackground(id: ProviderId, days: number) {
    void syncProvider(this.client, this.o.apiKey, id, days, this.now())
      .catch(() => undefined)
      .then(() => this.o.kv.set(ROWS_KEY, null));
  }
}
