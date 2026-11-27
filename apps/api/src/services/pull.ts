/**
 * Asking the apps behind SparkyFitness (Garmin, Fitbit, ...) to pull again. SparkyFitness pulls from
 * them about once an hour but only looks at the last day or two, so sleep that a watch uploads late,
 * or a workout logged in the app days afterwards, would be missed. Two things re-ask for the last
 * seven days (today included) and then re-read SparkyFitness into Gauntlet, which overwrites those
 * days: "Sync now", and a background job every few hours per person. Anything older than a week is
 * left to the history import. Neither blocks a request, a person is never asked twice at once, and
 * they share one cooldown so a manual and a scheduled pull never double up on Garmin.
 */
import { listConnections, syncProvider } from '@gauntlet/sparky';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { users } from '../db/schema.js';
import { connectionsEnv } from '../routes/connections.js';
import { syncUser } from './sync.js';
import { getUser, sparkyToken } from './users.js';

/** syncProvider counts back from today, so 6 days back is a week including today. */
export const PULL_DAYS = 6;
export const PULL_COOLDOWN_MS = 5 * 60_000;
/** The background re-pull runs for each person this often, spread out so nobody is pulled together. */
export const SCHEDULED_PULL_MS = 6 * 3_600_000;
/** At most this many people are pulled at once in the background. */
const SCHEDULED_CONCURRENCY = 2;
/** Apps that take longer than this are left to finish on their own; the next sync picks them up. */
const PULL_WAIT_MS = 120_000;

const lastPull = new Map<string, number>();
const pulling = new Set<string>();
/** When each person's next background pull is due (seeded with a per-person offset). */
const nextScheduled = new Map<string, number>();

interface Started {
  labels: string[];
  /** Resolves once the apps have answered (or timed out) and Gauntlet has re-read SparkyFitness. */
  done: Promise<void>;
}

async function startPull(ctx: AppContext, userId: string): Promise<Started | null> {
  const now = ctx.now().getTime();
  const last = lastPull.get(userId);
  if ((last != null && now - last < PULL_COOLDOWN_MS) || pulling.has(userId)) return null;
  const user = await getUser(ctx, userId);
  if (user.isDemo || user.keyStatus !== 'active' || !user.sparkyKeyEnc) return null;
  const token = sparkyToken(ctx, user);
  const connected = (await listConnections(ctx.sparky, token, connectionsEnv(ctx))).filter(
    (c) => c.state === 'connected' && c.id !== 'wger',
  );
  if (!connected.length) return null;
  lastPull.set(userId, now);
  pulling.add(userId);

  const timeout = <T>(p: Promise<T>) =>
    Promise.race([p, new Promise<void>((resolve) => setTimeout(resolve, PULL_WAIT_MS).unref())]);
  // One app at a time would be kindest to the providers, but Garmin can take a minute: ask in
  // parallel for one person, which is still only a handful of calls.
  const done = Promise.allSettled(
    connected.map((c) =>
      timeout(syncProvider(ctx.sparky, token, c.id, PULL_DAYS, ctx.now())).catch((err) =>
        ctx.log.warn({ err: String(err), id: c.id }, 'pulling from app failed'),
      ),
    ),
  )
    .then(() => syncUser(ctx, userId))
    .then(() => undefined)
    .catch((err) => ctx.log.warn({ err: String(err) }, 'sync after pulling apps failed'))
    .finally(() => pulling.delete(userId));
  return { labels: connected.map((c) => c.label), done };
}

/**
 * Start pulling the last seven days from every connected app. Returns the labels of the apps asked
 * (empty when there are none, or when this person pulled within the cooldown).
 */
export async function pullConnectedApps(ctx: AppContext, userId: string): Promise<string[]> {
  return (await startPull(ctx, userId))?.labels ?? [];
}

/** A stable offset within the period, so people are pulled at different times of day. */
function offsetFor(userId: string): number {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % SCHEDULED_PULL_MS;
}

/**
 * Background re-pull: for each person whose turn it is, ask their apps for the last seven days and
 * re-sync, a couple of people at a time. Called often (every scheduler tick); only people who are
 * due do anything. Returns how many people were pulled.
 */
export async function runScheduledPulls(ctx: AppContext): Promise<number> {
  const now = ctx.now().getTime();
  const rows = await ctx.db
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.keyStatus, 'active'), eq(users.isDemo, false), isNotNull(users.sparkyKeyEnc)),
    );
  const due: string[] = [];
  for (const { id } of rows) {
    let at = nextScheduled.get(id);
    if (at == null) nextScheduled.set(id, (at = now + offsetFor(id)));
    if (at <= now) due.push(id);
  }
  let count = 0;
  const queue = [...due];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      try {
        const started = await startPull(ctx, id);
        if (!started) {
          // Pulled a moment ago (by hand), or nothing connected: try again next period.
          nextScheduled.set(id, now + SCHEDULED_PULL_MS);
          continue;
        }
        nextScheduled.set(id, now + SCHEDULED_PULL_MS);
        await started.done;
        count++;
      } catch (err) {
        nextScheduled.set(id, now + SCHEDULED_PULL_MS);
        ctx.log.warn({ err: String(err), userId: id }, 'scheduled pull failed');
      }
    }
  };
  await Promise.all(Array.from({ length: SCHEDULED_CONCURRENCY }, worker));
  return count;
}

/** Tests only. */
export function resetPullCooldowns() {
  lastPull.clear();
  pulling.clear();
  nextScheduled.clear();
}
