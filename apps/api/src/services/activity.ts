/**
 * "Last active": when a person last used Gauntlet themselves. Stamped on signing in, refreshing a
 * session, and any signed-in request (see requireUser), but at most every ~10 minutes per person so
 * it costs almost nothing. Background work (the scheduler's syncs, backups, badge checks) never
 * goes through those paths, so it never counts: only a human with the app open does. The demo
 * account is left alone.
 *
 * The admin account page uses this to find accounts nobody uses, and to give a scheduled deletion
 * its way out: if they were active after it was scheduled, the deletion is called off.
 */
import { sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';

export const ACTIVITY_THROTTLE_MS = 10 * 60_000;

const pending = new Set<Promise<unknown>>();

/** One conditional UPDATE: it matches (and writes) only when the stamp is missing or stale. */
export async function touchActive(ctx: AppContext, userId: string): Promise<void> {
  const now = ctx.now();
  const stale = new Date(now.getTime() - ACTIVITY_THROTTLE_MS);
  await ctx.db.execute(
    sql`update users set last_active_at = ${now.toISOString()}::timestamptz
        where id = ${userId} and not is_demo
          and (last_active_at is null or last_active_at < ${stale.toISOString()}::timestamptz)`,
  );
}

/** Fire and forget; a failure here must never break the request that triggered it. */
export function touchActiveInBackground(ctx: AppContext, userId: string): void {
  const p: Promise<unknown> = touchActive(ctx, userId)
    .catch((err) => ctx.log.debug({ err: String(err) }, 'activity stamp failed'))
    .finally(() => pending.delete(p));
  pending.add(p);
}

/** Resolves when every stamp started so far has been written (tests use this). */
export async function settleActivity(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}
