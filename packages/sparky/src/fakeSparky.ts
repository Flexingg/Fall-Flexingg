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
  SleepRow,
} from './client.js';

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
  ingested: unknown[];
}

export class FakeSparky {
  readonly baseUrl = 'https://sparky.test';
  readonly trustedOrigin = 'http://localhost:3004';
  users = new Map<string, FakeUser>();
  /** token -> user id (sessions and API keys alike). */
  tokens = new Map<string, { userId: string; kind: 'session' | 'key'; keyId?: string }>();
  pendingTwoFactor = new Map<string, string>();
  calls: string[] = [];
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
      ingested: [],
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
      return json(200, { trusted_origin: this.trustedOrigin });

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
      return json(200, {
        exerciseEntries: user.exerciseEntries.filter((r) =>
          inRange(r.entry_date, q.get('startDate')!, q.get('endDate')!),
        ),
      });
    }
    if (method === 'GET' && path === '/api/sleep')
      return json(
        200,
        user.sleep.filter((r) => inRange(r.entry_date, q.get('startDate')!, q.get('endDate')!)),
      );
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
