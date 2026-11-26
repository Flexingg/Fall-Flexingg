/**
 * "Sync now" for the apps behind SparkyFitness. SparkyFitness pulls from Garmin, Fitbit and the rest
 * about once an hour on its own; this asks every connected app to pull its last couple of days now,
 * then re-reads SparkyFitness into Gauntlet once they're done. It never blocks the caller, and each
 * person can only set it off once every few minutes so nobody hammers Garmin.
 */
import { listConnections, syncProvider } from '@gauntlet/sparky';
import type { AppContext } from '../context.js';
import { connectionsEnv } from '../routes/connections.js';
import { syncUser } from './sync.js';
import { getUser, sparkyToken } from './users.js';

const PULL_DAYS = 2;
export const PULL_COOLDOWN_MS = 5 * 60_000;
/** Apps that take longer than this are left to finish on their own; the next sync picks them up. */
const PULL_WAIT_MS = 120_000;

const lastPull = new Map<string, number>();

/**
 * Start pulling from every connected app. Returns the labels of the apps asked (empty when there are
 * none, or when this person pulled within the cooldown).
 */
export async function pullConnectedApps(ctx: AppContext, userId: string): Promise<string[]> {
  const now = ctx.now().getTime();
  const last = lastPull.get(userId);
  if (last != null && now - last < PULL_COOLDOWN_MS) return [];
  const user = await getUser(ctx, userId);
  if (user.isDemo || user.keyStatus !== 'active' || !user.sparkyKeyEnc) return [];
  const token = sparkyToken(ctx, user);
  const connected = (await listConnections(ctx.sparky, token, connectionsEnv(ctx))).filter(
    (c) => c.state === 'connected' && c.id !== 'wger',
  );
  if (!connected.length) return [];
  lastPull.set(userId, now);

  const timeout = <T>(p: Promise<T>) =>
    Promise.race([p, new Promise<void>((resolve) => setTimeout(resolve, PULL_WAIT_MS).unref())]);
  void Promise.allSettled(
    connected.map((c) =>
      timeout(syncProvider(ctx.sparky, token, c.id, PULL_DAYS, ctx.now())).catch((err) =>
        ctx.log.warn({ err: String(err), id: c.id }, 'pulling from app failed'),
      ),
    ),
  )
    .then(() => syncUser(ctx, userId))
    .catch((err) => ctx.log.warn({ err: String(err) }, 'sync after pulling apps failed'));
  return connected.map((c) => c.label);
}

/** Tests only. */
export function resetPullCooldowns() {
  lastPull.clear();
}
