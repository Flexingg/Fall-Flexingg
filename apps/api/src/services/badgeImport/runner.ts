/**
 * The badge import run: fetch the Garmin list, remember badges we haven't seen as pending
 * suggestions, then ask Claude about the pending ones (4 at a time). One run at a time, enforced
 * with a Postgres advisory lock (held by a transaction for the whole run, so a crash frees it).
 * State (last run, last result) lives in server_state under "badge_import".
 */
import {
  SUGGESTION_STATUSES,
  type BadgeImportStatus,
  type BadgeSuggestion,
  type SuggestionStatus,
} from '@gauntlet/shared';
import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { badgeSuggestions, serverState } from '../../db/schema.js';
import { fetchGarminBadges, garminBadgeUrl } from './garmin.js';
import { LlmAuthError, LlmUnavailableError, proposeBadge } from './llm.js';

const LOCK_ID = 7_340_113;
const STATE_KEY = 'badge_import';
const CONCURRENCY = 4;
const DAY_MS = 86_400_000;

type Row = typeof badgeSuggestions.$inferSelect;
type LastResult = NonNullable<BadgeImportStatus['lastResult']>;
interface State {
  lastRunAt: string | null;
  lastResult: (LastResult & { error?: string | null }) | null;
  running: boolean;
}

export const importEnabled = (ctx: AppContext) => ctx.cfg.ANTHROPIC_API_KEY.length > 0;

async function readState(ctx: AppContext): Promise<State> {
  const [row] = await ctx.db.select().from(serverState).where(eq(serverState.key, STATE_KEY));
  const v = (row?.value ?? {}) as Partial<State>;
  return { lastRunAt: v.lastRunAt ?? null, lastResult: v.lastResult ?? null, running: !!v.running };
}

async function writeState(ctx: AppContext, patch: Partial<State>) {
  const next = { ...(await readState(ctx)), ...patch };
  await ctx.db
    .insert(serverState)
    .values({ key: STATE_KEY, value: next })
    .onConflictDoUpdate({ target: serverState.key, set: { value: next, updatedAt: new Date() } });
}

/** True while some run (in this or another process) holds the lock. */
async function lockHeld(ctx: AppContext): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const [r] = await tx.execute<{ ok: boolean }>(
      sql`select pg_try_advisory_xact_lock(${LOCK_ID}) as ok`,
    );
    return !r?.ok;
  });
}

export function toSuggestion(r: Row): BadgeSuggestion {
  return {
    id: r.id,
    status: r.status,
    source: {
      ref: r.sourceRef,
      name: r.sourceName,
      description: r.sourceDescription,
      category: r.sourceCategory,
      start: r.sourceStart,
      end: r.sourceEnd,
      url: garminBadgeUrl(r.sourceRef),
    },
    draft: r.draft ?? null,
    reason: r.reason,
    badgeKey: r.badgeKey,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function getImportStatus(ctx: AppContext): Promise<BadgeImportStatus> {
  // Probe the lock first: reading the state afterwards can't show a run as over but not yet saved.
  const running = await lockHeld(ctx);
  const state = await readState(ctx);
  const grouped = await ctx.db
    .select({ status: badgeSuggestions.status, n: sql<number>`count(*)`.mapWith(Number) })
    .from(badgeSuggestions)
    .groupBy(badgeSuggestions.status);
  const counts = Object.fromEntries(SUGGESTION_STATUSES.map((s) => [s, 0])) as Record<
    SuggestionStatus,
    number
  >;
  for (const g of grouped) counts[g.status] = g.n;
  return {
    enabled: importEnabled(ctx),
    model: ctx.cfg.BADGE_IMPORT_MODEL,
    // The lock is the truth (it dies with the process); the saved flag is only informational.
    running,
    lastRunAt: state.lastRunAt,
    lastResult: state.lastResult,
    counts,
  };
}

const todayOf = (ctx: AppContext) => ctx.now().toISOString().slice(0, 10);
/** Admin decisions that a late LLM answer must not overwrite. */
const open = () => notInArray(badgeSuggestions.status, ['approved', 'dismissed']);

type Outcome = 'matched' | 'skipped' | 'failed' | 'auth_error';

/** Decide one suggestion and save the result. */
export async function processSuggestion(
  ctx: AppContext,
  row: Row,
): Promise<{ outcome: Outcome; error?: string }> {
  const set = async (v: Partial<typeof badgeSuggestions.$inferInsert>) => {
    await ctx.db
      .update(badgeSuggestions)
      .set({ ...v, decidedAt: null })
      .where(and(eq(badgeSuggestions.id, row.id), open()));
  };
  if (row.sourceEnd && row.sourceEnd < todayOf(ctx)) {
    await set({ status: 'skipped', reason: 'Already over', draft: null });
    return { outcome: 'skipped' };
  }
  try {
    const p = await proposeBadge(ctx, {
      id: row.sourceRef,
      name: row.sourceName,
      description: row.sourceDescription,
      category: row.sourceCategory,
      start: row.sourceStart,
      end: row.sourceEnd,
    });
    const model = ctx.cfg.BADGE_IMPORT_MODEL;
    if (p.decision === 'match') {
      await set({ status: 'matched', draft: p.draft, reason: p.reason, model });
      return { outcome: 'matched' };
    }
    if (p.decision === 'skip') {
      await set({ status: 'skipped', draft: null, reason: p.reason, model });
      return { outcome: 'skipped' };
    }
    await set({ status: 'failed', draft: null, reason: p.reason, model });
    return { outcome: 'failed' };
  } catch (err) {
    if (err instanceof LlmAuthError) return { outcome: 'auth_error', error: err.message };
    const reason =
      err instanceof LlmUnavailableError
        ? err.message
        : `Unexpected error: ${(err as Error).message}`;
    await set({ status: 'failed', draft: null, reason: reason.slice(0, 400) });
    return { outcome: 'failed' };
  }
}

async function work(
  ctx: AppContext,
  opts: { retry: boolean; limit: number },
): Promise<LastResult & { error?: string }> {
  const result: LastResult & { error?: string } = {
    fetched: 0,
    added: 0,
    matched: 0,
    skipped: 0,
    failed: 0,
  };
  try {
    const badges = await fetchGarminBadges(ctx);
    result.fetched = badges.length;
    const known = new Set(
      (await ctx.db.select({ ref: badgeSuggestions.sourceRef }).from(badgeSuggestions)).map(
        (r) => r.ref,
      ),
    );
    const fresh = badges.filter((b) => !known.has(b.id));
    for (let i = 0; i < fresh.length; i += 200) {
      const added = await ctx.db
        .insert(badgeSuggestions)
        .values(
          fresh.slice(i, i + 200).map((b) => ({
            sourceRef: b.id,
            sourceName: b.name,
            sourceDescription: b.description,
            sourceCategory: b.category,
            sourceStart: b.start,
            sourceEnd: b.end,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: badgeSuggestions.id });
      result.added += added.length;
    }

    const statuses: SuggestionStatus[] = opts.retry
      ? ['pending', 'skipped', 'failed']
      : ['pending'];
    const rows = await ctx.db
      .select()
      .from(badgeSuggestions)
      .where(inArray(badgeSuggestions.status, statuses))
      .orderBy(badgeSuggestions.createdAt, badgeSuggestions.sourceRef);
    const today = todayOf(ctx);
    // Badges whose dates have passed cost nothing: no model call.
    const queue: Row[] = [];
    for (const r of rows) {
      if (r.sourceEnd && r.sourceEnd < today) {
        const o = await processSuggestion(ctx, r);
        if (o.outcome === 'skipped' && r.status !== 'skipped') result.skipped++;
      } else queue.push(r);
    }
    const todo = queue.slice(0, opts.limit);
    let next = 0;
    let stop = false;
    const worker = async () => {
      while (!stop && next < todo.length) {
        const row = todo[next++]!;
        const o = await processSuggestion(ctx, row);
        if (o.outcome === 'auth_error') {
          stop = true;
          result.error = `${o.error}. Check ANTHROPIC_API_KEY; the rest stay pending.`;
        } else result[o.outcome]++;
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } catch (err) {
    result.error = (err as Error).message;
  }
  return result;
}

export interface StartedImport {
  started: boolean;
  /** Settles when the run is over (never rejects). */
  done: Promise<(LastResult & { error?: string }) | null>;
}

/** Start a run if none is going; resolves once we know whether we got the lock. */
export async function startBadgeImport(
  ctx: AppContext,
  opts: { retry?: boolean; limit?: number } = {},
): Promise<StartedImport> {
  if (!importEnabled(ctx)) return { started: false, done: Promise.resolve(null) };
  let acquired!: (v: boolean) => void;
  const gotIt = new Promise<boolean>((r) => (acquired = r));
  const done = ctx.db
    .transaction(async (tx) => {
      const [lock] = await tx.execute<{ ok: boolean }>(
        sql`select pg_try_advisory_xact_lock(${LOCK_ID}) as ok`,
      );
      if (!lock?.ok) {
        acquired(false);
        return null;
      }
      acquired(true);
      await writeState(ctx, { running: true });
      let result: (LastResult & { error?: string }) | null = null;
      try {
        result = await work(ctx, { retry: opts.retry ?? false, limit: opts.limit ?? 1000 });
      } catch (err) {
        result = {
          fetched: 0,
          added: 0,
          matched: 0,
          skipped: 0,
          failed: 0,
          error: (err as Error).message,
        };
      }
      await writeState(ctx, {
        running: false,
        lastRunAt: ctx.now().toISOString(),
        lastResult: result,
      });
      if (result.error) ctx.log.warn({ error: result.error }, 'badge import problem');
      else ctx.log.info(result, 'badge import finished');
      return result;
    })
    .catch((err) => {
      acquired(false);
      ctx.log.error({ err: (err as Error).message }, 'badge import failed');
      return null;
    });
  return { started: await gotIt, done };
}

export async function runBadgeImport(
  ctx: AppContext,
  opts: { retry?: boolean; limit?: number } = {},
) {
  const s = await startBadgeImport(ctx, opts);
  return s.started ? s.done : null;
}

/** Scheduler hook: run when enabled and the last run is older than BADGE_IMPORT_DAYS. */
export async function maybeRunScheduledImport(ctx: AppContext): Promise<void> {
  const days = ctx.cfg.BADGE_IMPORT_DAYS;
  if (!importEnabled(ctx) || days <= 0) return;
  const { lastRunAt } = await readState(ctx);
  if (lastRunAt && ctx.now().getTime() - new Date(lastRunAt).getTime() < days * DAY_MS) return;
  await runBadgeImport(ctx);
}

export async function listSuggestions(ctx: AppContext, status?: SuggestionStatus) {
  const rows = await ctx.db
    .select()
    .from(badgeSuggestions)
    .where(
      status
        ? eq(badgeSuggestions.status, status)
        : notInArray(badgeSuggestions.status, ['dismissed']),
    )
    .orderBy(
      desc(badgeSuggestions.createdAt),
      sql`length(${badgeSuggestions.sourceRef}) desc`,
      desc(badgeSuggestions.sourceRef),
    );
  return rows.map(toSuggestion);
}
