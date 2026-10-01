import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AppContext } from './context.js';
import { challengeParticipants, challenges, users } from './db/schema.js';
import { finalizeChallenge } from './services/challenges.js';
import { syncUser } from './services/sync.js';

/** Only one API instance runs the background loop at a time. */
const LOCK_ID = 7_340_112;

/**
 * Every interval: sync everyone who is in a running challenge, then close
 * challenges that have ended. Users not competing are synced when they open
 * the app instead.
 */
export async function runSyncCycle(ctx: AppContext): Promise<{ synced: number; finalized: number }> {
  const [lock] = await ctx.db.execute<{ ok: boolean }>(sql`select pg_try_advisory_lock(${LOCK_ID}) as ok`);
  if (!lock?.ok) return { synced: 0, finalized: 0 };
  try {
    const open = await ctx.db.select().from(challenges).where(isNull(challenges.finalizedAt));
    const ids = open.map((c) => c.id);
    const competitors = ids.length
      ? await ctx.db
          .selectDistinct({ userId: challengeParticipants.userId })
          .from(challengeParticipants)
          .innerJoin(users, eq(users.id, challengeParticipants.userId))
          .where(and(inArray(challengeParticipants.challengeId, ids), eq(challengeParticipants.state, 'joined'), eq(users.keyStatus, 'active')))
      : [];
    let synced = 0;
    // Gentle on SparkyFitness: a few users at a time.
    for (let i = 0; i < competitors.length; i += 4) {
      const batch = competitors.slice(i, i + 4);
      const results = await Promise.all(batch.map((c) => syncUser(ctx, c.userId).catch((err) => ({ ok: false, err }))));
      synced += results.filter((r) => r.ok).length;
    }
    let finalized = 0;
    for (const ch of open) if (await finalizeChallenge(ctx, ch)) finalized++;
    await ctx.db.execute(sql`delete from refresh_tokens where expires_at < now() - interval '7 days'`);
    await ctx.db.execute(sql`delete from pending_logins where expires_at < now()`);
    return { synced, finalized };
  } finally {
    await ctx.db.execute(sql`select pg_advisory_unlock(${LOCK_ID})`);
  }
}

export function startScheduler(ctx: AppContext, minutes: number): () => void {
  if (minutes <= 0) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runSyncCycle(ctx);
      if (r.synced || r.finalized) ctx.log.info(r, 'sync cycle');
    } catch (err) {
      ctx.log.error({ err }, 'sync cycle failed');
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 10_000);
  const timer = setInterval(tick, minutes * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
