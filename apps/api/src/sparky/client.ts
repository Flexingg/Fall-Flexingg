/**
 * Thin typed client for the SparkyFitness REST API. Every call is made
 * server-side, so SparkyFitness' CORS rules never apply to Gauntlet's clients.
 */

export class SparkyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'SparkyError';
  }

  get isAuthError() {
    return this.status === 401 || this.status === 403;
  }
}

export interface SparkyUser {
  id: string;
  email: string;
  name: string | null;
}

export type SignInResult =
  | { kind: 'ok'; token: string; user: SparkyUser }
  | { kind: 'two_factor'; cookie: string };

export interface DailyHealthRow {
  entry_date: string;
  source_provider?: string | null;
  total_steps?: number | null;
  total_distance_meters?: number | null;
  active_calories?: number | null;
  exercise_minutes?: number | null;
  moderate_intensity_minutes?: number | null;
  vigorous_intensity_minutes?: number | null;
  resting_heart_rate?: number | null;
}

export interface CheckInRow {
  entry_date: string;
  steps?: number | string | null;
  weight?: number | string | null;
  updated_at?: string;
}

export interface CustomCategory {
  id: string;
  name: string;
  display_name?: string | null;
  measurement_type?: string | null;
  data_type?: string | null;
  frequency?: string | null;
}

export interface CustomMeasurementRow {
  date: string;
  hour?: number | null;
  value: number | string;
  timestamp?: string | null;
}

export interface ExerciseDayBucket {
  startDate: string;
  distanceMeters: number;
  durationMinutes: number;
  caloriesBurned: number;
  workoutCount: number;
}

export interface ExerciseEntryRow {
  entry_date: string;
  exercise_name?: string | null;
  calories_burned?: number | string | null;
  duration_minutes?: number | string | null;
  exercise_source?: string | null;
  exercise_category?: string | null;
}

export interface SleepRow {
  entry_date: string;
  duration_in_seconds?: number | null;
  time_asleep_in_seconds?: number | null;
  source?: string | null;
}

export interface SyncedSource {
  source: string;
  totalCount: number;
}

type FetchLike = typeof fetch;

export interface SparkyClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export class SparkyClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private trustedOrigin: string | null = null;

  constructor(opts: SparkyClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  get url() {
    return this.baseUrl;
  }

  // ---------------------------------------------------------------- auth

  async settings(): Promise<{ trusted_origin?: string; email?: { enabled?: boolean }; oidc?: { enabled?: boolean } }> {
    return this.request('GET', '/api/auth/settings');
  }

  /** Better Auth rejects sign-in requests whose Origin isn't trusted, so send the one it advertises. */
  private async origin(): Promise<string> {
    if (!this.trustedOrigin) {
      const s = await this.settings().catch(() => ({}) as { trusted_origin?: string });
      this.trustedOrigin = s.trusted_origin || this.baseUrl;
    }
    return this.trustedOrigin;
  }

  async signIn(email: string, password: string): Promise<SignInResult> {
    const res = await this.raw('POST', '/api/auth/sign-in/email', {
      body: { email, password },
      headers: { Origin: await this.origin() },
    });
    const body = (await readJson(res)) as Record<string, unknown> | null;
    if (!res.ok) throw new SparkyError(errorMessage(body) ?? 'Sign-in failed', res.status, body);
    if (body?.twoFactorRedirect) {
      return { kind: 'two_factor', cookie: cookieHeader(res) };
    }
    const token = typeof body?.token === 'string' ? body.token : null;
    const user = body?.user as Record<string, unknown> | undefined;
    if (!token || !user?.id) throw new SparkyError('Unexpected sign-in response', 502, body);
    return { kind: 'ok', token, user: toUser(user) };
  }

  async verifyTwoFactor(cookie: string, code: string, method: 'totp' | 'otp'): Promise<{ token: string; user: SparkyUser }> {
    const res = await this.raw('POST', `/api/auth/two-factor/verify-${method}`, {
      body: { code },
      headers: { Origin: await this.origin(), Cookie: cookie },
    });
    const body = (await readJson(res)) as Record<string, unknown> | null;
    if (!res.ok) throw new SparkyError(errorMessage(body) ?? 'Invalid code', res.status, body);
    const token = typeof body?.token === 'string' ? body.token : null;
    const user = body?.user as Record<string, unknown> | undefined;
    if (!token || !user?.id) throw new SparkyError('Unexpected 2FA response', 502, body);
    return { token, user: toUser(user) };
  }

  async createApiKey(sessionToken: string, name: string): Promise<{ id: string; key: string }> {
    const body = await this.request<{ apiKey?: { id: string; key: string } }>('POST', '/api/identity/user/generate-api-key', {
      token: sessionToken,
      body: { name, expiresIn: 60 * 60 * 24 * 365 },
    });
    if (!body.apiKey?.key) throw new SparkyError('SparkyFitness did not return an API key', 502, body);
    return { id: body.apiKey.id, key: body.apiKey.key };
  }

  async deleteApiKey(token: string, keyId: string): Promise<void> {
    await this.request('DELETE', `/api/identity/user/api-key/${encodeURIComponent(keyId)}`, { token });
  }

  async signOut(sessionToken: string): Promise<void> {
    await this.raw('POST', '/api/auth/sign-out', { token: sessionToken, headers: { Origin: await this.origin() }, body: {} }).catch(
      () => undefined,
    );
  }

  async currentUser(token: string): Promise<SparkyUser> {
    const body = await this.request<Record<string, unknown>>('GET', '/api/identity/user', { token });
    const id = (body.activeUserId ?? body.authenticatedUserId ?? body.id) as string | undefined;
    if (!id) throw new SparkyError('Unexpected user response', 502, body);
    return {
      id,
      email: String(body.activeUserEmail ?? body.authenticatedUserEmail ?? body.email ?? ''),
      name: (body.activeUserFullName as string | null | undefined) ?? null,
    };
  }

  // ---------------------------------------------------------------- reads

  async dailyHealthMetrics(token: string, start: string, end: string): Promise<DailyHealthRow[]> {
    const body = await this.request<{ data?: DailyHealthRow[] } | DailyHealthRow[]>(
      'GET',
      `/api/generic-health/metrics?startDate=${start}&endDate=${end}`,
      { token },
    );
    return Array.isArray(body) ? body : (body.data ?? []);
  }

  async checkIns(token: string, start: string, end: string): Promise<CheckInRow[]> {
    return asArray(await this.request('GET', `/api/measurements/check-in-measurements-range/${start}/${end}`, { token }));
  }

  async customCategories(token: string): Promise<CustomCategory[]> {
    return asArray(await this.request('GET', '/api/measurements/custom-categories', { token }));
  }

  async customMeasurements(token: string, categoryId: string, start: string, end: string): Promise<CustomMeasurementRow[]> {
    return asArray(
      await this.request('GET', `/api/measurements/custom-measurements-range/${encodeURIComponent(categoryId)}/${start}/${end}`, {
        token,
      }),
    );
  }

  /** Per-day workout totals (excludes SparkyFitness' synthetic "Active Calories" entries). */
  async exerciseDays(token: string, start: string, end: string): Promise<ExerciseDayBucket[]> {
    const body = await this.request<{ intervalsBreakdown?: ExerciseDayBucket[] }>(
      'GET',
      `/api/exercise-stats/summary?interval=day&startDate=${start}&endDate=${end}&unitSystem=metric`,
      { token },
    );
    return body.intervalsBreakdown ?? [];
  }

  /** Raw exercise entries, used for phone-synced "Active Calories" entries. */
  async exerciseEntries(token: string, start: string, end: string): Promise<ExerciseEntryRow[]> {
    const body = await this.request<{ exerciseEntries?: ExerciseEntryRow[] }>(
      'GET',
      `/api/reports?startDate=${start}&endDate=${end}`,
      { token },
    );
    return body.exerciseEntries ?? [];
  }

  async sleep(token: string, start: string, end: string): Promise<SleepRow[]> {
    const body = await this.request<SleepRow[] | { data?: SleepRow[] }>('GET', `/api/sleep?startDate=${start}&endDate=${end}`, {
      token,
    });
    return Array.isArray(body) ? body : (body.data ?? []);
  }

  async syncedSources(token: string): Promise<SyncedSource[]> {
    return asArray(await this.request('GET', '/api/synced-data/sources', { token }));
  }

  // ---------------------------------------------------------------- writes

  async ingestHealthData(token: string, records: unknown[]): Promise<{ processed: number; errors: unknown[] }> {
    const body = await this.request<{ processed?: unknown[]; errors?: unknown[] }>('POST', '/api/health-data', {
      token,
      body: records,
      headers: { 'X-Workout-Model-Version': '3' },
    });
    return { processed: body.processed?.length ?? 0, errors: body.errors ?? [] };
  }

  // ---------------------------------------------------------------- plumbing

  private async request<T = unknown>(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    let attempt = 0;
    for (;;) {
      const res = await this.raw(method, path, opts);
      if (res.status === 429 && attempt < 2) {
        attempt++;
        const retryAfter = Number(res.headers.get('retry-after')) || attempt * 2;
        await new Promise((r) => setTimeout(r, Math.min(retryAfter, 10) * 1000));
        continue;
      }
      const body = await readJson(res);
      if (!res.ok) {
        throw new SparkyError(errorMessage(body) ?? `${method} ${path} failed with ${res.status}`, res.status, body);
      }
      return body as T;
    }
  }

  private async raw(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'manual',
      });
    } catch (err) {
      throw new SparkyError(`Could not reach SparkyFitness: ${(err as Error).message}`, 503);
    }
  }
}

function toUser(u: Record<string, unknown>): SparkyUser {
  return {
    id: String(u.id),
    email: String(u.email ?? ''),
    name: (u.name as string | undefined) ?? (u.full_name as string | undefined) ?? null,
  };
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 200) };
  }
}

function errorMessage(body: unknown): string | null {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const msg = b.error ?? b.message;
    if (typeof msg === 'string') return msg;
    if (msg && typeof msg === 'object' && typeof (msg as { message?: unknown }).message === 'string') {
      return (msg as { message: string }).message;
    }
  }
  return null;
}

function asArray<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)) {
    return (body as { data: T[] }).data;
  }
  return [];
}

/** Collapse Set-Cookie headers into a Cookie header value (name=value pairs only). */
function cookieHeader(res: Response): string {
  const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
  return all
    .map((c) => c.split(';')[0]?.trim())
    .filter((c): c is string => !!c)
    .join('; ');
}
