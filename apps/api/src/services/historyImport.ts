/**
 * History import: a background job that brings up to five years of older data into Gauntlet.
 *
 * Step A, per linked app that can do it: ask SparkyFitness to pull the range from the app, in small
 * chunks, newest first, with a polite pause (Garmin and Fitbit rate-limit hard). A failing app never
 * fails the job; it is reported on its own row and the rest carries on.
 * Step B ("sparky"): read SparkyFitness in chunks, newest first, through the same fetch and store
 * code the normal sync uses, so a day has the same values either way.
 *
 * What it deliberately does NOT do, per chunk: post "progress" to the feed, announce records, re-rank
 * challenges or celebrate badges. Those run once at the end: records are brought up to date (but not
 * announced unless set in the last few days), challenges are re-ranked, and badges the older data
 * unlocked arrive as ONE notification.
 *
 * State lives in server_state (`history:<userId>`), written after every chunk. If the server
 * restarts mid-import we RESUME it from the per-step cursors (the oldest day done), because a
 * multi-hour import shouldn't be lost to a deploy and the work is idempotent; after
 * MAX_RESUMES restarts in a row we stop trying and mark it interrupted so a crash loop can't
 * hammer SparkyFitness. One job per person, enforced in memory (one API process runs jobs).
 */
import {
  addDays,
  HISTORY_SUPPORT,
  IDLE_HISTORY,
  planChunks,
  requestedDays,
  todayIn,
  windowDays,
  type HistoryJobState,
  type HistorySourceId,
  type HistoryStatus,
  type HistoryStep,
  type HistorySummary,
  type ProviderId,
  type StartHistoryRequest,
} from '@gauntlet/shared';
import { ConnectionError, listConnections, SparkyError, syncProviderRange } from '@gauntlet/sparky';
import { and, eq, like, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { badRequest, HttpError } from '../context.js';
import { dailyMetrics, serverState, users } from '../db/schema.js';
import { connectionsEnv } from '../routes/connections.js';
import { checkBadges } from './badges/engine.js';
import { openChallengesForUser, refreshChallenge } from './challenges.js';
import { refreshPersonalRecords } from './records.js';
import { fetchWindow, scopeOf, storeWindow } from './sync.js';
import { demoBlocked, getUser, markKeyInvalid, sparkyToken } from './users.js';

/** Days per SparkyFitness read in step B. */
const READ_CHUNK_DAYS = 90;
/** Records set within this many days are announced as usual; older ones are filed quietly. */
const QUIET_DAYS = 3;
const RATE_RETRIES = 2;
const MAX_RESUMES = 3;
/** Give up on one app after this many chunks in a row fail. */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Pacing knobs; tests set them to zero. */
export const historyTuning = {
  /** Pause between SparkyFitness calls for the same app. */
  paceMs: 1500,
  /** Base wait after a rate-limit answer (multiplied by the attempt number). */
  rateBackoffMs: 30_000,
};

interface StoredJob {
  state: HistoryJobState;
  range: { start: string; end: string; days: number };
  steps: HistoryStep[];
  /** Per step: the oldest day already done. The next chunk ends the day before. */
  cursors: Record<string, string>;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  summary: HistorySummary | null;
  baseline: { oldest: string | null; days: number };
  stats: { workouts: number; stored: boolean };
  resumes: number;
}

const stateKey = (userId: string) => `history:${userId}`;

interface Runner {
  cancel: boolean;
  done: Promise<void>;
  /** The job being worked on; the runner saves this copy after every chunk. */
  job: StoredJob;
}
const active = new Map<string, Runner>();

/** Resolves when this person's job (if any) has finished running. For tests and shutdown. */
export const whenHistoryDone = (userId: string): Promise<void> =>
  active.get(userId)?.done ?? Promise.resolve();

async function load(ctx: AppContext, userId: string): Promise<StoredJob | null> {
  const [row] = await ctx.db
    .select()
    .from(serverState)
    .where(eq(serverState.key, stateKey(userId)));
  return (row?.value as StoredJob | undefined) ?? null;
}

async function save(ctx: AppContext, userId: string, job: StoredJob): Promise<void> {
  await ctx.db
    .insert(serverState)
    .values({ key: stateKey(userId), value: job, updatedAt: ctx.now() })
    .onConflictDoUpdate({
      target: serverState.key,
      set: { value: job, updatedAt: ctx.now() },
    });
}

function toStatus(job: StoredJob | null, running: boolean): HistoryStatus {
  if (!job) return IDLE_HISTORY;
  // "running" in storage with nobody working on it: the server stopped and could not resume.
  const state = job.state === 'running' && !running ? 'interrupted' : job.state;
  return {
    running,
    state,
    range: job.range,
    steps: job.steps.map((s) =>
      s.state === 'running' && !running ? { ...s, state: 'waiting' } : s,
    ),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    summary: job.summary,
    error:
      state === 'interrupted' && !job.error
        ? 'The server restarted before this finished. Start it again to carry on.'
        : job.error,
  };
}

export async function getHistoryStatus(ctx: AppContext, userId: string): Promise<HistoryStatus> {
  const runner = active.get(userId);
  return toStatus(runner?.job ?? (await load(ctx, userId)), !!runner);
}

/** Oldest day with data (ignoring goals) and how many days have some, between two dates. */
async function dataFootprint(
  ctx: AppContext,
  userId: string,
  start: string,
  end: string,
): Promise<{ oldest: string | null; days: number }> {
  const notGoal = sql`${dailyMetrics.metric} not like 'goal\\_%'`;
  const [row] = await ctx.db
    .select({
      oldest: sql<string | null>`min(${dailyMetrics.date})::text`,
      days: sql<number>`count(distinct ${dailyMetrics.date}) filter (where ${dailyMetrics.date} between ${start} and ${end})::int`,
    })
    .from(dailyMetrics)
    .where(and(eq(dailyMetrics.userId, userId), notGoal));
  return { oldest: row?.oldest ?? null, days: row?.days ?? 0 };
}

export async function startHistoryImport(
  ctx: AppContext,
  userId: string,
  req: StartHistoryRequest,
): Promise<HistoryStatus> {
  const user = await getUser(ctx, userId);
  if (user.isDemo) throw demoBlocked();
  if (user.keyStatus !== 'active' || !user.sparkyKeyEnc)
    throw new HttpError(
      409,
      'Your SparkyFitness connection expired. Sign in again.',
      'sparky_key_invalid',
    );
  if (active.has(userId))
    throw new HttpError(409, 'An import is already running.', 'history_running');

  const days = requestedDays(req);
  const end = todayIn(user.timezone, ctx.now());
  const start = addDays(end, -days);
  const token = sparkyToken(ctx, user);
  const wanted = req.sources ? new Set<string>(req.sources) : null;
  const want = (id: string) => !wanted || wanted.has(id);

  const steps: HistoryStep[] = [];
  const total = days + 1;
  const connections = await listConnections(ctx.sparky, token, connectionsEnv(ctx));
  for (const c of connections) {
    if (c.state !== 'connected' || !want(c.id)) continue;
    const support = HISTORY_SUPPORT[c.id];
    if (support.mode === 'none') continue;
    steps.push({
      source: c.id,
      label: c.label,
      state: support.mode === 'recent' ? 'skipped' : 'waiting',
      doneDays: 0,
      totalDays: total,
      error: null,
      note: support.note,
    });
  }
  if (want('sparky'))
    steps.push({
      source: 'sparky',
      label: 'Reading it all into Gauntlet',
      state: 'waiting',
      doneDays: 0,
      totalDays: total,
      error: null,
      note: null,
    });
  if (!steps.some((s) => s.state === 'waiting'))
    throw badRequest('Nothing to import from the sources you picked.', 'nothing_to_import');

  const job: StoredJob = {
    state: 'running',
    range: { start, end, days },
    steps,
    cursors: {},
    startedAt: ctx.now().toISOString(),
    finishedAt: null,
    error: null,
    summary: null,
    baseline: await dataFootprint(ctx, userId, start, end),
    stats: { workouts: 0, stored: false },
    resumes: 0,
  };
  await save(ctx, userId, job);
  launch(ctx, userId, job);
  return toStatus(job, true);
}

/** Stop after the chunk in progress. What was stored stays. */
export async function cancelHistoryImport(ctx: AppContext, userId: string): Promise<HistoryStatus> {
  const runner = active.get(userId);
  if (!runner || runner.cancel || runner.job.state !== 'running')
    return toStatus(runner?.job ?? (await load(ctx, userId)), !!runner);
  runner.cancel = true;
  runner.job.state = 'cancelled';
  runner.job.finishedAt = ctx.now().toISOString();
  await save(ctx, userId, runner.job);
  return toStatus(runner.job, true);
}

/** At startup: carry on with imports a restart cut short (see the note at the top). */
export async function resumeHistoryImports(ctx: AppContext): Promise<number> {
  const rows = await ctx.db.select().from(serverState).where(like(serverState.key, 'history:%'));
  let resumed = 0;
  for (const row of rows) {
    const job = row.value as StoredJob;
    const userId = row.key.slice('history:'.length);
    if (job?.state !== 'running' || active.has(userId)) continue;
    job.resumes = (job.resumes ?? 0) + 1;
    if (job.resumes > MAX_RESUMES) {
      job.state = 'interrupted';
      job.finishedAt = ctx.now().toISOString();
      job.error = 'The server kept restarting during this import. Start it again to carry on.';
      await save(ctx, userId, job);
      continue;
    }
    await save(ctx, userId, job);
    launch(ctx, userId, job);
    resumed++;
  }
  return resumed;
}

function launch(ctx: AppContext, userId: string, job: StoredJob) {
  const runner: Runner = { cancel: false, done: Promise.resolve(), job };
  runner.done = run(ctx, userId, job, runner)
    .catch((err) => ctx.log.error({ err, userId }, 'history import crashed'))
    .finally(() => active.delete(userId));
  active.set(userId, runner);
}

// ---------------------------------------------------------------- the job

interface JobCtx {
  ctx: AppContext;
  userId: string;
  job: StoredJob;
  runner: Runner;
  persist: () => Promise<void>;
}

const sleep = async (ms: number, runner: Runner) => {
  // In slices, so a cancel is noticed within a second.
  for (let left = ms; left > 0 && !runner.cancel; left -= 1000)
    await new Promise((r) => setTimeout(r, Math.min(left, 1000)));
};

async function run(ctx: AppContext, userId: string, job: StoredJob, runner: Runner) {
  const jc: JobCtx = { ctx, userId, job, runner, persist: () => save(ctx, userId, job) };
  try {
    const token = sparkyToken(ctx, await getUser(ctx, userId));
    for (const step of job.steps) {
      if (runner.cancel) break;
      if (step.state !== 'waiting' && step.state !== 'running') continue;
      step.state = 'running';
      await jc.persist();
      if (step.source === 'sparky') await readIntoGauntlet(jc, token, step);
      else await pullFromApp(jc, token, step, step.source as ProviderId);
      await jc.persist();
    }
    if (job.state === 'running') job.state = 'done';
  } catch (err) {
    if (err instanceof SparkyError && err.status === 401) {
      await markKeyInvalid(ctx, userId);
      job.error = 'Your SparkyFitness connection expired. Sign in again.';
    } else {
      ctx.log.warn({ err, userId }, 'history import failed');
      job.error = `Something went wrong: ${(err as Error).message.slice(0, 160)}`;
    }
    job.state = 'failed';
    for (const s of job.steps) if (s.state === 'running') s.state = 'failed';
  }
  if (runner.cancel) {
    for (const s of job.steps)
      if (s.state === 'waiting' || s.state === 'running') s.state = 'cancelled';
    job.state = 'cancelled';
  }
  await jc.persist();

  // Once, at the end, with whatever was stored (even after a cancel or a failure).
  if (job.stats.stored) await finish(jc);
  job.finishedAt = ctx.now().toISOString();
  await jc.persist();
}

async function finish({ ctx, userId, job }: JobCtx) {
  const user = await getUser(ctx, userId);
  const today = todayIn(user.timezone, ctx.now());
  const records = await refreshPersonalRecords(ctx, userId, {
    quietBefore: addDays(today, -QUIET_DAYS),
  }).catch((err) => {
    ctx.log.warn({ err: String(err), userId }, 'record check after history import failed');
    return { alerts: 0, updated: 0 };
  });
  const badges = await checkBadges(ctx, userId, { reason: 'sync', history: true }).catch((err) => {
    ctx.log.warn({ err: String(err), userId }, 'badge check after history import failed');
    return [];
  });
  // Challenges are re-ranked once, not per chunk.
  for (const ch of await openChallengesForUser(ctx, userId))
    await refreshChallenge(ctx, ch.id).catch(() => undefined);
  const after = await dataFootprint(ctx, userId, job.range.start, job.range.end);
  job.summary = {
    oldestBefore: job.baseline.oldest,
    oldestAfter: after.oldest,
    newDays: Math.max(0, after.days - job.baseline.days),
    newRecords: records.updated,
    newBadges: new Set(badges.map((b) => b.key)).size,
    workouts: job.stats.workouts,
  };
}

interface Failure {
  /** In words a person can read. */
  message: string;
  /** Give up on this source (rather than skip just this chunk). */
  stop: boolean;
  /** Worth another try after a pause (rate limits, timeouts). */
  retry: boolean;
}

interface ChunkRun {
  failedChunks: number;
  lastError: string | null;
  stoppedEarly: boolean;
}

/**
 * Run date windows newest first for one step: skip the ones a resumed job already did, retry
 * rate limits with a growing pause, skip a chunk that keeps failing, and give up on the source
 * after a few failures in a row. The cursor and progress are saved after every chunk.
 */
async function eachChunk(
  jc: JobCtx,
  step: HistoryStep,
  windows: { start: string; end: string }[],
  doChunk: (w: { start: string; end: string }) => Promise<void>,
  classify: (err: unknown) => Failure,
): Promise<ChunkRun> {
  const { job, runner } = jc;
  const out: ChunkRun = { failedChunks: 0, lastError: null, stoppedEarly: false };
  let inARow = 0;
  for (const w of windows) {
    if (runner.cancel) break;
    const cursor = job.cursors[step.source];
    if (cursor && w.start >= cursor) continue;
    for (let attempt = 0; ; attempt++) {
      try {
        await doChunk(w);
        inARow = 0;
        break;
      } catch (err) {
        if (err instanceof SparkyError && err.status === 401) throw err;
        const f = classify(err);
        if (f.retry && attempt < RATE_RETRIES && !runner.cancel) {
          await sleep(historyTuning.rateBackoffMs * (attempt + 1), runner);
          continue;
        }
        out.failedChunks++;
        out.lastError = f.message;
        if (f.stop || ++inARow >= MAX_CONSECUTIVE_FAILURES) {
          out.stoppedEarly = true;
          return out;
        }
        break;
      }
    }
    job.cursors[step.source] = w.start;
    step.doneDays = Math.min(step.totalDays, step.doneDays + windowDays(w));
    await jc.persist();
    await sleep(historyTuning.paceMs, runner);
  }
  return out;
}

/** Say how a step ended. */
function conclude(jc: JobCtx, step: HistoryStep, run: ChunkRun, what: string) {
  const { job } = jc;
  const reached = job.cursors[step.source];
  if (run.stoppedEarly) {
    step.state = 'failed';
    step.error = `${run.lastError ?? `${step.label} stopped.`}${reached ? ` Imported back to ${reached}.` : ''}`;
  } else if (jc.runner.cancel) step.state = 'cancelled';
  else {
    step.state = 'done';
    if (run.failedChunks)
      step.error = `${run.failedChunks} ${run.failedChunks === 1 ? 'stretch' : 'stretches'} of ${what} couldn't be imported${run.lastError ? ` (${run.lastError})` : ''}.`;
  }
}

function classifyApp(label: string) {
  return (err: unknown): Failure => {
    if (err instanceof ConnectionError) {
      if (
        /rate_limited/.test(err.code) ||
        /rate limit|too many requests|\b429\b/i.test(err.message)
      )
        return {
          message: `${label} is limiting requests right now. Try again in an hour or so.`,
          stop: true,
          retry: true,
        };
      if (
        ['provider_reauth', 'garmin_credentials', 'provider_key', 'provider_subscription'].includes(
          err.code,
        )
      )
        return { message: err.message, stop: true, retry: false };
      if (/unreachable/.test(err.code)) return { message: err.message, stop: false, retry: true };
      return { message: err.message, stop: false, retry: false };
    }
    const text = (err as Error).message ?? String(err);
    if (/rate limit|too many requests|\b429\b/i.test(text))
      return {
        message: `${label} is limiting requests right now. Try again in an hour or so.`,
        stop: true,
        retry: true,
      };
    return { message: `${label} didn't answer (${text.slice(0, 120)}).`, stop: false, retry: true };
  };
}

/** Step A: ask SparkyFitness to pull a range from one linked app. */
async function pullFromApp(jc: JobCtx, token: string, step: HistoryStep, id: ProviderId) {
  const { ctx, job } = jc;
  const support = HISTORY_SUPPORT[id];
  const end = todayIn('UTC', ctx.now());
  const classify = classifyApp(step.label);
  if (support.mode === 'full') {
    // No date filter on the app's side: one call fetches the lot.
    const run = await eachChunk(
      jc,
      step,
      [{ start: job.range.start, end }],
      (w) => syncProviderRange(ctx.sparky, token, id, w.start, w.end, { full: true }),
      classify,
    );
    conclude(jc, step, run, 'history');
    return;
  }
  const windows = planChunks(job.range.start, end, support.chunkDays);
  const run = await eachChunk(
    jc,
    step,
    windows,
    (w) => syncProviderRange(ctx.sparky, token, id, w.start, w.end),
    classify,
  );
  conclude(jc, step, run, 'history');
}

/** Step B: read what SparkyFitness has into Gauntlet's own tables. */
async function readIntoGauntlet(jc: JobCtx, token: string, step: HistoryStep) {
  const { ctx, userId, job } = jc;
  const user = await getUser(ctx, userId);
  const scope = scopeOf(await openChallengesForUser(ctx, userId));
  // One day ahead of UTC, like the normal sync, so people east of it get their "today".
  const end = addDays(todayIn('UTC', ctx.now()), 1);
  let partial = 0;
  const run = await eachChunk(
    jc,
    step,
    planChunks(job.range.start, end, READ_CHUNK_DAYS),
    async (w) => {
      const fetched = await fetchWindow(ctx, user, token, w.start, w.end, scope, {
        maxGoalFetches: READ_CHUNK_DAYS,
      });
      if (fetched.partial) partial++;
      await storeWindow(ctx, userId, user.timezone, w.start, w.end, fetched, scope);
      job.stats.stored = true;
      job.stats.workouts += fetched.workouts.length;
    },
    () => ({
      message: "SparkyFitness didn't answer.",
      stop: false,
      retry: true,
    }),
  );
  conclude(jc, step, run, 'data');
  if (partial && step.state === 'done')
    step.error = `Some data in ${partial} ${partial === 1 ? 'stretch' : 'stretches'} couldn't be read from SparkyFitness.`;
}
