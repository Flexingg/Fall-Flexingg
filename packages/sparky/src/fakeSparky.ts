/**
 * In-memory stand-in for a SparkyFitness server, shaped after the real
 * endpoints Gauntlet calls. Plugged into SparkyClient through its `fetch` option.
 */
import type {
  CheckInRow,
  CustomCategory,
  CustomMeasurementRow,
  DailyHealthRow,
  ExerciseDayBucket,
  ExerciseEntryRow,
  FastRow,
  GoalsRow,
  NutritionDayRow,
  SleepRow,
  WaterRow,
} from './client.js';

/** SparkyFitness' default goals for someone who never set any. */
export const DEFAULT_GOALS: GoalsRow = {
  calories: 2000,
  protein: 150,
  carbs: 250,
  fat: 67,
  water_goal_ml: 1920,
};

export interface FakeUser {
  id: string;
  email: string;
  password: string;
  name: string;
  twoFactorCode?: string;
  daily: DailyHealthRow[];
  checkIns: CheckInRow[];
  categories: CustomCategory[];
  custom: Record<string, CustomMeasurementRow[]>;
  exerciseDays: ExerciseDayBucket[];
  exerciseEntries: ExerciseEntryRow[];
  sleep: SleepRow[];
  nutrition: NutritionDayRow[];
  water: WaterRow[];
  /** Goals from a date on (sorted by date), like SparkyFitness' goal history. */
  goals: { from: string; goals: GoalsRow }[];
  fasts: FastRow[];
  ingested: unknown[];
  /** Set once the person has linked Garmin Connect inside this SparkyFitness. */
  garmin?: { linkedAt: string; syncs: number };
  /** The person's own linked-app records (what SparkyFitness lists under external providers). */
  providers: FakeProvider[];
}

export interface FakeProvider {
  id: string;
  provider_type: string;
  provider_name: string;
  is_active: boolean;
  is_public: boolean;
  has_token: boolean;
  sync_frequency: string;
  last_sync_at: string | null;
  app_id?: string;
  app_key?: string;
  syncs: number;
}

export class FakeSparky {
  readonly baseUrl = 'https://sparky.test';
  readonly trustedOrigin = 'http://localhost:3004';
  users = new Map<string, FakeUser>();
  /** token -> user id (sessions and API keys alike). */
  tokens = new Map<string, { userId: string; kind: 'session' | 'key'; keyId?: string }>();
  pendingTwoFactor = new Map<string, string>();
  calls: string[] = [];
  /** X-Forwarded-For seen on auth calls (Gauntlet passes the end user's address). */
  forwardedFor: string[] = [];
  signupDisabled = false;
  /** Garmin accounts the pretend Garmin service accepts; mfaCode makes sign-in ask for a code. */
  garminAccounts = new Map<string, { password: string; mfaCode?: string }>();
  private garminPending = new Map<string, string>();
  /** Set to make the Garmin service answer like a refused connection. */
  garminDown = false;
  /** API keys Hevy and Liftosaur accept; anything else gets their "invalid key" answer. */
  goodAppKeys = new Set<string>(['good-hevy-key', 'good-liftosaur-key']);
  /** The OAuth code every pretend provider accepts. */
  goodOAuthCode = 'good-code';
  /** Every provider sync asked for, in order, with the range (history import runs many). */
  syncLog: { userId: string; route: string; startDate: string; endDate: string; full: boolean }[] =
    [];
  /** Make a provider sync fail: return the answer to give, or null to let it through. */
  failSync?: (
    route: string,
    range: { startDate: string; endDate: string },
  ) => { status: number; error: string } | null;
  /** Artificial response delay per user id (ms), to force sync interleavings in tests. */
  latencyMs: Record<string, number> = {};
  private seq = 0;

  addUser(u: Pick<FakeUser, 'id' | 'email' | 'password' | 'name'> & Partial<FakeUser>): FakeUser {
    const user: FakeUser = {
      daily: [],
      checkIns: [],
      categories: [],
      custom: {},
      exerciseDays: [],
      exerciseEntries: [],
      sleep: [],
      nutrition: [],
      water: [],
      goals: [],
      fasts: [],
      ingested: [],
      providers: [],
      ...u,
    };
    this.users.set(user.id, user);
    return user;
  }

  /** Mint an API key directly, as a user would in SparkyFitness settings. */
  mintKey(userId: string): string {
    const key = `k${'x'.repeat(60)}${++this.seq}`;
    this.tokens.set(key, { userId, kind: 'key', keyId: `key-${this.seq}` });
    return key;
  }

  revokeAllKeys(userId: string) {
    for (const [t, v] of this.tokens)
      if (v.userId === userId && v.kind === 'key') this.tokens.delete(t);
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname;
    this.calls.push(`${method} ${path}`);
    const json = (status: number, data: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json', ...extra },
      });

    if (method === 'GET' && path === '/api/auth/settings')
      return json(200, {
        trusted_origin: this.trustedOrigin,
        signup_disabled: this.signupDisabled,
      });

    if (path.startsWith('/api/auth/') && headers.get('x-forwarded-for'))
      this.forwardedFor.push(headers.get('x-forwarded-for')!);

    // Mirrors SparkyFitness 1.7 (Better Auth) responses.
    if (method === 'POST' && path === '/api/auth/sign-up/email') {
      if (headers.get('origin') !== this.trustedOrigin)
        return json(403, { message: 'Invalid origin' });
      if (this.signupDisabled)
        return json(400, { message: 'Signups are currently disabled by the administrator.' });
      if (String(body.password ?? '').length < 8)
        return json(400, { message: 'Password too short', code: 'PASSWORD_TOO_SHORT' });
      const email = String(body.email).toLowerCase();
      if ([...this.users.values()].some((u) => u.email === email))
        return json(422, {
          message: 'User already exists. Use another email.',
          code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
        });
      const user = this.addUser({
        id: `sparky-${++this.seq}`,
        email,
        password: String(body.password),
        name: String(body.name),
      });
      return json(200, {
        token: this.session(user.id),
        user: { id: user.id, email: user.email, name: user.name },
      });
    }

    if (method === 'POST' && path === '/api/auth/sign-in/email') {
      if (headers.get('origin') !== this.trustedOrigin)
        return json(403, { message: 'Invalid origin' });
      const user = [...this.users.values()].find(
        (u) => u.email === body.email && u.password === body.password,
      );
      if (!user) return json(401, { message: 'Invalid email or password' });
      if (user.twoFactorCode) {
        const cookie = `tf${++this.seq}`;
        this.pendingTwoFactor.set(cookie, user.id);
        return json(
          200,
          { twoFactorRedirect: true },
          { 'set-cookie': `sparky.two_factor=${cookie}; Path=/; HttpOnly` },
        );
      }
      return json(200, {
        token: this.session(user.id),
        user: { id: user.id, email: user.email, name: user.name },
      });
    }

    if (method === 'POST' && path === '/api/auth/two-factor/verify-totp') {
      const cookie = /sparky\.two_factor=([^;]+)/.exec(headers.get('cookie') ?? '')?.[1];
      const userId = cookie ? this.pendingTwoFactor.get(cookie) : undefined;
      const user = userId ? this.users.get(userId) : undefined;
      if (!user || body.code !== user.twoFactorCode) return json(401, { message: 'Invalid code' });
      this.pendingTwoFactor.delete(cookie!);
      return json(200, {
        token: this.session(user.id),
        user: { id: user.id, email: user.email, name: user.name },
      });
    }

    const auth = headers.get('authorization')?.replace(/^Bearer /, '');
    const who = auth ? this.tokens.get(auth) : undefined;
    if (!who) return json(401, { error: 'Authentication required.' });
    const user = this.users.get(who.userId)!;
    const delay = this.latencyMs[user.id];
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const q = url.searchParams;
    const inRange = (d: string, s: string, e: string) => d >= s && d <= e;

    if (method === 'POST' && path === '/api/auth/sign-out') {
      this.tokens.delete(auth!);
      return json(200, { success: true });
    }
    if (method === 'POST' && path === '/api/identity/user/generate-api-key') {
      const key = this.mintKey(user.id);
      return json(201, {
        message: 'ok',
        apiKey: {
          id: this.tokens.get(key)!.keyId,
          key,
          name: body.name,
          createdAt: new Date().toISOString(),
        },
      });
    }
    const del = /^\/api\/identity\/user\/api-key\/(.+)$/.exec(path);
    if (method === 'DELETE' && del) {
      for (const [t, v] of this.tokens)
        if (v.keyId === del[1] && v.userId === user.id) this.tokens.delete(t);
      return json(200, { message: 'deleted' });
    }
    if (method === 'GET' && path === '/api/identity/user') {
      return json(200, {
        authenticatedUserId: user.id,
        activeUserId: user.id,
        activeUserEmail: user.email,
        activeUserFullName: user.name,
      });
    }
    if (method === 'GET' && path === '/api/generic-health/metrics') {
      return json(200, {
        data: user.daily.filter((r) =>
          inRange(r.entry_date, q.get('startDate')!, q.get('endDate')!),
        ),
      });
    }
    const checkIn = /^\/api\/measurements\/check-in-measurements-range\/([\d-]+)\/([\d-]+)$/.exec(
      path,
    );
    if (method === 'GET' && checkIn)
      return json(
        200,
        user.checkIns.filter((r) => inRange(r.entry_date, checkIn[1]!, checkIn[2]!)),
      );
    if (method === 'GET' && path === '/api/measurements/custom-categories')
      return json(200, user.categories);
    const custom =
      /^\/api\/measurements\/custom-measurements-range\/([^/]+)\/([\d-]+)\/([\d-]+)$/.exec(path);
    if (method === 'GET' && custom) {
      return json(
        200,
        (user.custom[custom[1]!] ?? []).filter((r) => inRange(r.date, custom[2]!, custom[3]!)),
      );
    }
    if (method === 'GET' && path === '/api/exercise-stats/summary') {
      return json(200, {
        intervalsBreakdown: user.exerciseDays.filter((b) =>
          inRange(b.startDate, q.get('startDate')!, q.get('endDate')!),
        ),
      });
    }
    if (method === 'GET' && path === '/api/reports') {
      const [from, to] = [q.get('startDate')!, q.get('endDate')!];
      return json(200, {
        exerciseEntries: user.exerciseEntries
          .filter((r) => inRange(r.entry_date, from, to))
          .map((r) => ({ sets: [], ...r })),
        nutritionData: user.nutrition
          .filter((r) => inRange(r.date, from, to))
          .map((r) => ({
            water: user.water.find((w) => w.entry_date === r.date)?.water_ml ?? 0,
            ...r,
          })),
      });
    }
    const water = /^\/api\/measurements\/water-intake-range\/([\d-]+)\/([\d-]+)$/.exec(path);
    if (method === 'GET' && water)
      return json(
        200,
        user.water.filter((r) => inRange(r.entry_date, water[1]!, water[2]!)),
      );
    const goals = /^\/api\/goals\/by-date\/([\d-]+)$/.exec(path);
    if (method === 'GET' && goals) {
      const set = user.goals.filter((g) => g.from <= goals[1]!).at(-1);
      return json(200, set?.goals ?? DEFAULT_GOALS);
    }
    const fasting = /^\/api\/fasting\/history\/range\/([\d-]+)\/([\d-]+)$/.exec(path);
    if (method === 'GET' && fasting)
      return json(
        200,
        user.fasts.filter((f) => inRange(f.start_time.slice(0, 10), fasting[1]!, fasting[2]!)),
      );
    if (method === 'GET' && path === '/api/fasting/current')
      return json(200, user.fasts.find((f) => f.status === 'ACTIVE') ?? null);
    if (method === 'POST' && path === '/api/fasting/start') {
      if (!body?.start_time || !body?.fasting_type)
        return json(400, { error: 'Start time and fasting type are required' });
      if (user.fasts.some((f) => f.status === 'ACTIVE'))
        return json(400, { error: 'There is already an active fast' });
      const fast: FastRow = {
        id: `fast-${++this.seq}`,
        start_time: new Date(body.start_time).toISOString(),
        target_end_time: body.target_end_time ? new Date(body.target_end_time).toISOString() : null,
        fasting_type: body.fasting_type,
        status: 'ACTIVE',
      };
      user.fasts.push(fast);
      return json(201, fast);
    }
    if (method === 'POST' && path === '/api/fasting/end') {
      const fast = user.fasts.find((f) => f.id === body?.id);
      if (!fast) return json(404, { error: 'Fast not found' });
      fast.end_time = new Date(body.end_time).toISOString();
      fast.duration_minutes = Math.round(
        (Date.parse(fast.end_time) - Date.parse(fast.start_time)) / 60_000,
      );
      fast.status = 'COMPLETED';
      return json(200, fast);
    }
    if (method === 'GET' && path === '/api/sleep')
      return json(
        200,
        user.sleep.filter((r) => inRange(r.entry_date, q.get('startDate')!, q.get('endDate')!)),
      );
    if (path.startsWith('/api/integrations/garmin/')) {
      const g = path.slice('/api/integrations/garmin/'.length);
      if (g === 'status')
        return json(
          200,
          user.garmin
            ? {
                isLinked: true,
                lastUpdated: user.garmin.linkedAt,
                tokenExpiresAt: null,
                message: 'Garmin Connect is linked.',
              }
            : { isLinked: false, message: 'Garmin Connect is not linked.' },
        );
      if (g === 'login' || g === 'resume_login') {
        if (this.garminDown)
          return json(500, {
            error: 'Failed to login to Garmin: connect ECONNREFUSED 127.0.0.1:8000',
          });
        if (g === 'login') {
          const acct = this.garminAccounts.get(String(body.email));
          if (!acct || acct.password !== body.password)
            return json(500, {
              error: 'Failed to login to Garmin: Garmin authentication failed: Invalid credentials',
            });
          if (acct.mfaCode) {
            const state = `mfa${++this.seq}`;
            this.garminPending.set(state, String(body.email));
            return json(200, { status: 'needs_mfa', client_state: state });
          }
        } else {
          const email = this.garminPending.get(String(body.client_state));
          if (!email)
            return json(500, {
              error:
                'Failed to login to Garmin: An unexpected error occurred: Invalid or expired mfa_token',
            });
          this.garminPending.delete(String(body.client_state));
          if (this.garminAccounts.get(email)?.mfaCode !== String(body.mfa_code))
            return json(500, {
              error: 'Failed to login to Garmin: Garmin MFA failed: Invalid MFA code',
            });
        }
        user.garmin = { linkedAt: new Date().toISOString(), syncs: 0 };
        return json(200, { status: 'success', provider: { id: 'garmin-provider' } });
      }
      if (g === 'sync') {
        if (!user.garmin) return json(400, { error: 'Garmin Connect is not linked.' });
        // Like SparkyFitness 1.7: at most 365 days per call, and never past tomorrow.
        const spanDays =
          (Date.parse(String(body.endDate)) - Date.parse(String(body.startDate))) / 86_400_000;
        if (spanDays > 365) return json(400, { error: 'Date range cannot exceed 365 days.' });
        if (String(body.endDate) > new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10))
          return json(400, { error: 'endDate cannot be in the future.' });
        this.syncLog.push({
          userId: user.id,
          route: 'garmin',
          startDate: String(body.startDate),
          endDate: String(body.endDate),
          full: false,
        });
        const refused = this.failSync?.('garmin', body);
        if (refused) return json(refused.status, { error: refused.error });
        user.garmin.syncs++;
        const day = String(body.endDate);
        user.daily = user.daily.filter(
          (r) => !(r.entry_date === day && r.source_provider === 'garmin'),
        );
        user.daily.push({ entry_date: day, source_provider: 'garmin', total_steps: 4321 });
        return json(200, { message: 'Garmin sync completed.' });
      }
      if (g === 'unlink') {
        if (!user.garmin)
          return json(400, { error: 'Garmin Connect account not found for this user.' });
        user.garmin = undefined;
        return json(200, { success: true });
      }
    }
    // Linked apps: the provider records and the per-provider endpoints, shaped like SparkyFitness's.
    if (path === '/api/external-providers' || path.startsWith('/api/external-providers/')) {
      const id = path.split('/')[3];
      if (method === 'GET' && !id)
        return json(200, [
          { id: 'public-wger', provider_type: 'wger', is_public: true, is_active: true },
          ...user.providers,
        ]);
      if (method === 'POST' && !id) {
        const rec: FakeProvider = {
          id: `prov-${++this.seq}`,
          provider_type: String(body.provider_type),
          provider_name: String(body.provider_name),
          is_active: body.is_active !== false,
          is_public: false,
          has_token: false,
          sync_frequency: String(body.sync_frequency ?? 'manual'),
          last_sync_at: null,
          app_id: body.app_id,
          app_key: body.app_key,
          syncs: 0,
        };
        user.providers.push(rec);
        return json(201, rec);
      }
      const rec = user.providers.find((p) => p.id === id);
      if (!rec) return json(404, { error: 'External data provider not found.' });
      if (method === 'PUT') {
        for (const k of ['is_active', 'sync_frequency', 'app_id', 'app_key'] as const)
          if (body[k] !== undefined) (rec as unknown as Record<string, unknown>)[k] = body[k];
        return json(200, rec);
      }
      if (method === 'DELETE') {
        user.providers = user.providers.filter((p) => p.id !== id);
        return json(200, { message: 'External data provider deleted successfully.' });
      }
    }
    const integ =
      /^\/api\/integrations\/(strava|fitbit|oura|polar|coros|hevy|liftosaur)\/(\w+)$/.exec(path);
    if (integ) {
      const [, route, action] = integ as unknown as [string, string, string];
      const type = route === 'coros' ? 'coros_mcp' : route;
      const rec = user.providers.find((p) => p.provider_type === type);
      const oauth = ['strava', 'fitbit', 'oura', 'polar', 'coros'].includes(route);
      if (action === 'status')
        return json(
          200,
          rec
            ? {
                connected: rec.is_active && (!oauth || rec.has_token),
                isActive: rec.is_active,
                lastSyncAt: rec.last_sync_at,
              }
            : { connected: false, isActive: false },
        );
      if (action === 'authorize') {
        if (!rec) return json(500, { error: 'Strava provider not configured.' });
        const url = `https://auth.${route}.test/authorize?client_id=${rec.app_id ?? 'dyn'}&state=st-${user.id}`;
        return json(200, route === 'strava' ? { url } : { authUrl: url });
      }
      if (action === 'callback') {
        if (!rec || body.code !== this.goodOAuthCode)
          return json(500, {
            message: `Error handling ${route} OAuth callback`,
            error: 'invalid_grant',
          });
        if ((route === 'polar' || route === 'coros') && !body.state)
          return json(400, { message: 'Invalid or expired authorization state.' });
        rec.has_token = true;
        rec.is_active = true;
        return json(200, { message: 'Account linked successfully.' });
      }
      if (action === 'sync') {
        if (!rec) return json(200, { success: true, processedCount: 0 });
        if (oauth && !rec.has_token)
          return json(500, {
            message: 'Error initiating manual sync',
            error: 'No access token available. Please authorize first.',
          });
        if (
          (route === 'hevy' || route === 'liftosaur') &&
          !this.goodAppKeys.has(String(rec.app_key))
        )
          return json(401, {
            message:
              route === 'hevy'
                ? 'Invalid Hevy API Key. Please check your key and try again.'
                : 'Invalid Liftosaur API key.',
            error: 'Request failed with status code 401',
          });
        this.syncLog.push({
          userId: user.id,
          route,
          startDate: String(body.startDate),
          endDate: String(body.endDate),
          full: body.fullSync === true,
        });
        const refused = this.failSync?.(route, body);
        if (refused) return json(refused.status, { message: refused.error, error: refused.error });
        rec.syncs++;
        rec.last_sync_at = new Date().toISOString();
        const day = String(body.endDate);
        user.daily = user.daily.filter(
          (r) => !(r.entry_date === day && r.source_provider === route),
        );
        user.daily.push({ entry_date: day, source_provider: route, total_steps: 1111 });
        return json(200, { success: true });
      }
      if (action === 'disconnect') {
        if (rec) {
          rec.has_token = false;
          rec.is_active = false;
        }
        return json(200, { message: 'Account disconnected successfully.' });
      }
    }
    if (method === 'GET' && path === '/api/synced-data/sources')
      return json(200, [{ source: 'garmin', totalCount: 120, byTable: {} }]);
    if (method === 'POST' && path === '/api/health-data') {
      const records = Array.isArray(body) ? body : [body];
      user.ingested.push(...records);
      for (const r of records) {
        if ((r.type === 'step' || r.type === 'steps') && r.date) {
          user.checkIns = user.checkIns.filter((c) => c.entry_date !== r.date);
          user.checkIns.push({
            entry_date: r.date,
            steps: r.value,
            updated_at: new Date().toISOString(),
          });
        }
        // Like SparkyFitness: body fat, height (to cm) and resting energy join the day's check-in,
        // and total calories burned goes in the daily summary.
        const column = (
          {
            body_fat: 'body_fat_percentage',
            BodyFat: 'body_fat_percentage',
            Height: 'height',
          } as const
        )[r.type as string];
        if ((column || r.type === 'bmr' || r.type === 'BasalMetabolicRate') && r.date) {
          const row: CheckInRow = user.checkIns.find((c) => c.entry_date === r.date) ?? {
            entry_date: r.date,
            updated_at: new Date().toISOString(),
          };
          if (!user.checkIns.includes(row)) user.checkIns.push(row);
          const v = Number(r.value);
          if (column === 'height') row.height = r.unit === 'm' ? v * 100 : v;
          else if (column) row.body_fat_percentage = v;
          else row.bmr = v;
        }
        if ((r.type === 'TotalCaloriesBurned' || r.type === 'total_calories') && r.date) {
          const src = String(r.source ?? 'Health Connect');
          user.daily = user.daily.filter(
            (d) => !(d.entry_date === r.date && d.source_provider === src),
          );
          user.daily.push({ entry_date: r.date, source_provider: src, total_calories: r.value });
        }
      }
      return json(200, {
        message: 'ok',
        processed: records.map(() => ({ status: 'success' })),
        errors: [],
        skipped: [],
      });
    }
    return json(404, { error: `Fake has no route for ${method} ${path}` });
  };

  private session(userId: string): string {
    const token = `session.${++this.seq}`;
    this.tokens.set(token, { userId, kind: 'session' });
    return token;
  }
}
