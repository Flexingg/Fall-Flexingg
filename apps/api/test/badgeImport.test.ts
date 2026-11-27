import type { BadgeImportStatus, BadgeSuggestion, MeUser } from '@gauntlet/shared';
import { SparkyClient } from '@gauntlet/sparky';
import { FakeSparky } from '@gauntlet/sparky/testing';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { badgeDefinitions, badgeSuggestions, serverState } from '../src/db/schema.js';
import { maybeRunScheduledImport, startBadgeImport } from '../src/services/badgeImport/runner.js';
import { setImportBackoff, setImportFetch } from '../src/services/badgeImport/http.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/gauntlet_test';
const fake = new FakeSparky();
let app: FastifyInstance;
let ctx: AppContext;
let offApp: FastifyInstance;
let closeDb: () => Promise<void>;
let db: ReturnType<typeof createDb>['db'];
const access: Record<string, string> = {};
const baseEnv = () => ({
  DATABASE_URL: DB_URL,
  SPARKY_URL: fake.baseUrl,
  PUBLIC_WEB_URL: 'https://gauntlet.test',
  JWT_SECRET: 'test-secret-test-secret-test-secret-123',
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  SYNC_INTERVAL_MINUTES: '0',
  ADMIN_EMAILS: 'boss@example.com',
});
const NOW = new Date('2026-11-26T12:00:00Z');

// ---- the mocked network ----
interface AnthropicCall {
  body: any;
  headers: Record<string, string>;
}
let garmin: unknown[] = [];
let garminHits = 0;
let garminGate: Promise<void> | null = null;
let anthropicCalls: AnthropicCall[] = [];
/** Return a status/body for an Anthropic call. */
let respond: (call: AnthropicCall, n: number) => Response | Promise<Response>;

const toolUse = (input: unknown) =>
  new Response(
    JSON.stringify({ content: [{ type: 'tool_use', id: 'tu_1', name: 'propose_badge', input }] }),
    { status: 200 },
  );
const draftFor = (id: string, over: Record<string, unknown> = {}) => ({
  key: `g-weekend-warrior-${id}`,
  name: 'Weekend warrior',
  description: 'Run {n} km in a single outing.',
  family: 'movement',
  icon: 'run',
  secret: false,
  rule: { type: 'single_activity', sport: 'run', measure: 'distance_km', tiers: [5, 10] },
  window: null,
  countsManual: true,
  ...over,
});
const match = (id: string, over?: Record<string, unknown>) =>
  toolUse({ decision: 'match', reason: 'Fits', draft: draftFor(id, over) });
const idOf = (c: AnthropicCall) => /Garmin badge #(\d+)/.exec(c.body.messages[0].content)![1]!;

function installFetch() {
  setImportFetch((async (input: any, init: any) => {
    const url = String(input);
    if (url.startsWith('https://api.anthropic.com/')) {
      const call = {
        body: JSON.parse(init.body),
        headers: init.headers as Record<string, string>,
      };
      anthropicCalls.push(call);
      return respond(call, anthropicCalls.length);
    }
    garminHits++;
    if (garminGate) await garminGate;
    return new Response(JSON.stringify(garmin), { status: 200 });
  }) as typeof fetch);
}
const gb = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Garmin ${id}`,
  description: `Do thing ${id}`,
  category: { key: 'running' },
  start_date: null,
  end_date: null,
  ...extra,
});

async function api<T = any>(
  who: string,
  method: 'GET' | 'POST',
  url: string,
  payload?: object,
  status = 200,
  target: FastifyInstance = app,
): Promise<T> {
  const res = await target.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${access[who]}` },
  });
  if (res.statusCode !== status)
    throw new Error(`${method} ${url} -> ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}
async function waitIdle() {
  for (let i = 0; i < 200; i++) {
    const s = await api<BadgeImportStatus>('admin', 'GET', '/api/admin/badge-suggestions/status');
    if (!s.running) return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('import never finished');
}
const rows = () => db.select().from(badgeSuggestions);
const byRef = async (ref: string) => (await rows()).find((r) => r.sourceRef === ref)!;

beforeAll(async () => {
  const created = createDb(DB_URL);
  db = created.db;
  closeDb = () => created.client.end();
  await db.execute(
    sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`,
  );
  await runMigrations(db);
  const mk = async (env: Record<string, string>) =>
    buildApp({
      db,
      cfg: loadConfig({ ...baseEnv(), ...env }),
      sparky: new SparkyClient({ baseUrl: fake.baseUrl, fetch: fake.fetch }),
      now: () => NOW,
    });
  ({ app, ctx } = await mk({ ANTHROPIC_API_KEY: 'sk-ant-test', BADGE_IMPORT_MODEL: 'test-model' }));
  ({ app: offApp } = await mk({}));
  for (const [w, email] of [
    ['admin', 'boss@example.com'],
    ['ana', 'ana@example.com'],
  ]) {
    fake.addUser({ id: `u-${w}`, email: email!, password: `pw-${w}`, name: w! });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { method: 'password', email, password: `pw-${w}` },
      headers: { 'x-gauntlet-client': 'native' },
    });
    access[w!] = (res.json() as { accessToken: string; user: MeUser }).accessToken;
  }
});
afterAll(async () => {
  setImportFetch(null);
  await app.close();
  await offApp.close();
  await closeDb();
});
beforeEach(async () => {
  await db.delete(badgeSuggestions);
  await db.delete(badgeDefinitions);
  await db.delete(serverState);
  garmin = [];
  garminHits = 0;
  garminGate = null;
  anthropicCalls = [];
  respond = (c) => match(idOf(c));
  setImportBackoff(1);
  installFetch();
});
afterEach(() => setImportFetch(null));

describe('diff and LLM step', () => {
  it('fetches politely, inserts only unseen ids, and matches', async () => {
    garmin = [gb(1), gb(2)];
    await api('admin', 'POST', '/api/admin/badge-suggestions/run', {}, 202);
    let st = await waitIdle();
    expect(st.lastResult).toMatchObject({
      fetched: 2,
      added: 2,
      matched: 2,
      skipped: 0,
      failed: 0,
    });
    expect(st.counts.matched).toBe(2);
    expect(st.enabled).toBe(true);
    expect(st.model).toBe('test-model');
    expect(st.lastRunAt).toBe(NOW.toISOString());
    expect(anthropicCalls).toHaveLength(2);

    // second run: one new id, the old rows are untouched and not re-sent to the model
    garmin = [gb(1), gb(2), gb(3)];
    anthropicCalls = [];
    await api('admin', 'POST', '/api/admin/badge-suggestions/run', {}, 202);
    st = await waitIdle();
    expect(st.lastResult).toMatchObject({ fetched: 3, added: 1, matched: 1 });
    expect(anthropicCalls.map(idOf)).toEqual(['3']);
    expect(await rows()).toHaveLength(3);

    const { suggestions } = await api<{ suggestions: BadgeSuggestion[] }>(
      'admin',
      'GET',
      '/api/admin/badge-suggestions',
    );
    expect(suggestions[0]!.source).toMatchObject({
      ref: '3',
      url: 'https://garminbadges.com/badges/3',
      category: 'running',
    });
    expect(suggestions[0]!.draft?.key).toBe('g-weekend-warrior-3');
  });

  it('sends the right request to Anthropic and never user data or the key in the body', async () => {
    garmin = [gb(5)];
    await api('admin', 'POST', '/api/admin/badge-suggestions/run', {}, 202);
    await waitIdle();
    const c = anthropicCalls[0]!;
    expect(c.headers['x-api-key']).toBe('sk-ant-test');
    expect(c.headers['anthropic-version']).toBe('2023-06-01');
    expect(c.body).toMatchObject({
      model: 'test-model',
      temperature: 0,
      max_tokens: 1500,
      tool_choice: { type: 'tool', name: 'propose_badge' },
    });
    expect(JSON.stringify(c.body)).not.toContain('sk-ant-test');
    expect(c.body.messages[0].content).toContain('Do thing 5');
  });

  it('records skips with the reason and the model', async () => {
    garmin = [gb(1)];
    respond = () => toolUse({ decision: 'skip', reason: 'Needs golf data' });
    await api('admin', 'POST', '/api/admin/badge-suggestions/run', {}, 202);
    const st = await waitIdle();
    expect(st.lastResult).toMatchObject({ skipped: 1, matched: 0 });
    const r = await byRef('1');
    expect(r).toMatchObject({
      status: 'skipped',
      reason: 'Needs golf data',
      model: 'test-model',
      draft: null,
    });
  });

  it('pins the key suffix, window and seasonal family for dated badges', async () => {
    garmin = [gb(9, { start_date: '2026-11-20T00:00:00Z', end_date: '2026-12-31T00:00:00Z' })];
    respond = () =>
      toolUse({
        decision: 'match',
        reason: 'ok',
        draft: draftFor('wrong', { key: 'Totally Wrong Key!', window: null }),
      });
    await api('admin', 'POST', '/api/admin/badge-suggestions/run', {}, 202);
    await waitIdle();
    const r = await byRef('9');
    expect(r.status).toBe('matched');
    expect(r.draft).toMatchObject({
      key: 'g-totally-wrong-key-9',
      family: 'seasonal',
      window: { start: '2026-11-20', end: '2026-12-31' },
    });
  });

  it('retries an invalid answer once with the error, then succeeds', async () => {
    garmin = [gb(1)];
    respond = (c, n) =>
      n === 1
        ? toolUse({ decision: 'match', reason: 'x', draft: draftFor('1', { icon: 'banana' }) })
        : match(idOf(c));
    await api('admin', 'POST', '/api/admin/badge-suggestions/run', {}, 202);
    await waitIdle();
    expect(anthropicCalls).toHaveLength(2);
    const second = anthropicCalls[1]!.body.messages;
    expect(second).toHaveLength(3);
    expect(second[2].content[0]).toMatchObject({ type: 'tool_result', is_error: true });
    expect(second[2].content[0].content).toContain('draft.icon');
    expect((await byRef('1')).status).toBe('matched');
  });

  it('marks failed after a second invalid answer', async () => {
    garmin = [gb(1)];
    respond = () => toolUse({ decision: 'match', reason: 'x', draft: draftFor('1', { name: '' }) });
    await api('admin', 'POST', '/api/admin/badge-suggestions/run', {}, 202);
    const st = await waitIdle();
    expect(anthropicCalls).toHaveLength(2);
    expect(st.lastResult?.failed).toBe(1);
    const r = await byRef('1');
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('did not pass checks');
  });

  it('backs off on 429 (respecting retry-after) and then succeeds', async () => {
    garmin = [gb(1)];
    const times: number[] = [];
    respond = (c, n) => {
      times.push(Date.now());
      return n < 3
        ? new Response('{}', { status: n === 1 ? 429 : 529, headers: { 'retry-after': '0' } })
        : match(idOf(c));
    };
    await api('admin', 'POST', '/api/admin/badge-suggestions/run', {}, 202);
    await waitIdle();
    expect(anthropicCalls).toHaveLength(3);
    expect((await byRef('1')).status).toBe('matched');
  });

  it('gives up after three busy answers and marks it failed', async () => {
    garmin = [gb(1)];
    respond = () => new Response('{}', { status: 500 });
    await api('admin', 'POST', '/api/admin/badge-suggestions/run', {}, 202);
    await waitIdle();
    expect(anthropicCalls).toHaveLength(3);
    const r = await byRef('1');
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('500');
  });

  it('stops the run on 401 and leaves the rest pending', async () => {
    garmin = Array.from({ length: 10 }, (_, i) => gb(i + 1));
    respond = () => new Response('{}', { status: 401 });
    await api('admin', 'POST', '/api/admin/badge-suggestions/run', {}, 202);
    const st = await waitIdle();
    expect(st.lastResult?.error).toContain('API key');
    expect(st.counts.pending).toBe(10);
    expect(st.counts.failed).toBe(0);
    // 4 in flight at most before the stop took effect
    expect(anthropicCalls.length).toBeLessThanOrEqual(4);
  });

  it('skips expired windows without calling the model', async () => {
    garmin = [
      gb(1, { start_date: '2026-01-01T00:00:00Z', end_date: '2026-02-01T00:00:00Z' }),
      gb(2, { start_date: '2026-11-01T00:00:00Z', end_date: '2026-11-26T00:00:00Z' }),
    ];
    await api('admin', 'POST', '/api/admin/badge-suggestions/run', {}, 202);
    const st = await waitIdle();
    expect(await byRef('1')).toMatchObject({ status: 'skipped', reason: 'Already over' });
    expect((await byRef('2')).status).toBe('matched'); // ends today: still on
    expect(anthropicCalls.map(idOf)).toEqual(['2']);
    expect(st.lastResult).toMatchObject({ added: 2, skipped: 1, matched: 1 });
  });

  it('retry re-checks skipped and failed only when asked; limit caps calls', async () => {
    garmin = [gb(1), gb(2), gb(3)];
    respond = (c) =>
      idOf(c) === '1'
        ? toolUse({ decision: 'skip', reason: 'no' })
        : new Response('{}', { status: 400 });
    await api('admin', 'POST', '/api/admin/badge-suggestions/run', {}, 202);
    await waitIdle();
    expect((await rows()).map((r) => r.status).sort()).toEqual(['failed', 'failed', 'skipped']);
    anthropicCalls = [];
    respond = (c) => match(idOf(c));
    await api('admin', 'POST', '/api/admin/badge-suggestions/run', {}, 202);
    await waitIdle();
    expect(anthropicCalls).toHaveLength(0);
    await api('admin', 'POST', '/api/admin/badge-suggestions/run', { retry: true, limit: 2 }, 202);
    const st = await waitIdle();
    expect(anthropicCalls).toHaveLength(2);
    expect(st.lastResult).toMatchObject({ matched: 2 });
  });
});

describe('lock', () => {
  it('lets only one run at a time', async () => {
    garmin = [gb(1)];
    let release!: () => void;
    garminGate = new Promise<void>((r) => (release = r));
    const first = await startBadgeImport(ctx);
    expect(first.started).toBe(true);
    const second = await startBadgeImport(ctx);
    expect(second.started).toBe(false);
    const st = await api<BadgeImportStatus>('admin', 'GET', '/api/admin/badge-suggestions/status');
    expect(st.running).toBe(true);
    await api('admin', 'POST', '/api/admin/badge-suggestions/run', {}, 409);
    release();
    await first.done;
    expect(garminHits).toBe(1);
    expect(
      (await api<BadgeImportStatus>('admin', 'GET', '/api/admin/badge-suggestions/status')).running,
    ).toBe(false);
  });
});

describe('permissions and switches', () => {
  it('is admin only', async () => {
    const routes: ['GET' | 'POST', string][] = [
      ['GET', '/api/admin/badge-suggestions'],
      ['GET', '/api/admin/badge-suggestions/status'],
      ['POST', '/api/admin/badge-suggestions/run'],
      ['POST', '/api/admin/badge-suggestions/00000000-0000-4000-8000-000000000000/approve'],
      ['POST', '/api/admin/badge-suggestions/00000000-0000-4000-8000-000000000000/dismiss'],
      ['POST', '/api/admin/badge-suggestions/00000000-0000-4000-8000-000000000000/retry'],
    ];
    for (const [method, url] of routes) {
      expect((await app.inject({ method, url })).statusCode, url).toBe(401);
      expect(
        (
          await app.inject({
            method,
            url,
            payload: {},
            headers: { authorization: `Bearer ${access.ana}` },
          })
        ).statusCode,
        url,
      ).toBe(403);
    }
  });

  it('is off without an API key: status says so and run answers 409', async () => {
    const st = await api<BadgeImportStatus>(
      'admin',
      'GET',
      '/api/admin/badge-suggestions/status',
      undefined,
      200,
      offApp,
    );
    expect(st.enabled).toBe(false);
    const res = await api<{ error: string; code: string }>(
      'admin',
      'POST',
      '/api/admin/badge-suggestions/run',
      {},
      409,
      offApp,
    );
    expect(res.code).toBe('import_disabled');
    expect(garminHits).toBe(0);
    expect(await rows()).toHaveLength(0);
  });

  it('reports a Garmin outage in lastResult without touching suggestions', async () => {
    setImportFetch((async () => new Response('nope', { status: 503 })) as typeof fetch);
    await api('admin', 'POST', '/api/admin/badge-suggestions/run', {}, 202);
    const st = await waitIdle();
    expect(st.lastResult?.error).toContain('503');
    expect(st.lastRunAt).not.toBeNull();
  });

  it('the scheduler hook runs only when the last run is old enough', async () => {
    garmin = [gb(1)];
    await maybeRunScheduledImport(ctx);
    expect(garminHits).toBe(1);
    await maybeRunScheduledImport(ctx); // ran just now (NOW), 7 days not passed
    expect(garminHits).toBe(1);
    await db
      .update(serverState)
      .set({ value: { lastRunAt: '2026-11-01T00:00:00Z', lastResult: null, running: false } })
      .where(eq(serverState.key, 'badge_import'));
    await maybeRunScheduledImport(ctx);
    expect(garminHits).toBe(2);
  });
});

describe('deciding on suggestions', () => {
  async function seeded() {
    garmin = [gb(1), gb(2)];
    await api('admin', 'POST', '/api/admin/badge-suggestions/run', {}, 202);
    await waitIdle();
    return rows();
  }

  it('approve creates a draft badge (with an admin-edited draft) and marks approved', async () => {
    const [s] = (await seeded()).filter((r) => r.sourceRef === '1');
    const draft = { ...(s!.draft as any), name: 'Edited name' };
    const { badge } = await api('admin', 'POST', `/api/admin/badge-suggestions/${s!.id}/approve`, {
      draft,
    });
    expect(badge).toMatchObject({
      key: 'g-weekend-warrior-1',
      name: 'Edited name',
      status: 'draft',
      origin: 'garmin',
      sourceRef: '1',
      earnedBy: 0,
    });
    const [def] = await db
      .select()
      .from(badgeDefinitions)
      .where(eq(badgeDefinitions.key, badge.key));
    expect(def).toMatchObject({
      status: 'draft',
      origin: 'garmin',
      sourceRef: '1',
      name: 'Edited name',
    });
    expect(await byRef('1')).toMatchObject({ status: 'approved', badgeKey: badge.key });
    await api('admin', 'POST', `/api/admin/badge-suggestions/${s!.id}/approve`, { draft }, 409);
  });

  it('approve rejects an invalid draft and a taken key', async () => {
    const [s, t] = await seeded();
    await api(
      'admin',
      'POST',
      `/api/admin/badge-suggestions/${s!.id}/approve`,
      { draft: { ...(s!.draft as any), icon: 'nope' } },
      400,
    );
    await api(
      'admin',
      'POST',
      `/api/admin/badge-suggestions/${s!.id}/approve`,
      { draft: s!.draft },
      200,
    );
    // same key again from the other suggestion
    await api(
      'admin',
      'POST',
      `/api/admin/badge-suggestions/${t!.id}/approve`,
      { draft: s!.draft },
      409,
    );
    expect((await byRef(t!.sourceRef)).status).toBe('matched');
  });

  it('dismiss hides it from the default list but not from ?status=dismissed', async () => {
    const [s] = await seeded();
    await api('admin', 'POST', `/api/admin/badge-suggestions/${s!.id}/dismiss`);
    const all = await api<{ suggestions: BadgeSuggestion[] }>(
      'admin',
      'GET',
      '/api/admin/badge-suggestions',
    );
    expect(all.suggestions).toHaveLength(1);
    const d = await api<{ suggestions: BadgeSuggestion[] }>(
      'admin',
      'GET',
      '/api/admin/badge-suggestions?status=dismissed',
    );
    expect(d.suggestions.map((x) => x.id)).toEqual([s!.id]);
    await api('admin', 'GET', '/api/admin/badge-suggestions?status=bogus', undefined, 400);
  });

  it('retry re-runs the model for one suggestion now', async () => {
    garmin = [gb(1)];
    respond = () => new Response('{}', { status: 400 });
    await api('admin', 'POST', '/api/admin/badge-suggestions/run', {}, 202);
    await waitIdle();
    const s = await byRef('1');
    expect(s.status).toBe('failed');
    respond = (c) => match(idOf(c));
    const { suggestion } = await api<{ suggestion: BadgeSuggestion }>(
      'admin',
      'POST',
      `/api/admin/badge-suggestions/${s.id}/retry`,
    );
    expect(suggestion).toMatchObject({ id: s.id, status: 'matched', reason: 'Fits' });
    await api('admin', 'POST', `/api/admin/badge-suggestions/${s.id}/retry`, {}, 200, app);
    await api('admin', 'POST', `/api/admin/badge-suggestions/${s.id}/retry`, {}, 409, offApp);
  });
});
