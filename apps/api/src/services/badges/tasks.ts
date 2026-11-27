/**
 * Fire-and-forget badge work (checks after a social action, backfills after publishing). Each task
 * is tracked so tests (and a graceful shutdown) can wait for everything in flight to finish.
 */
import type { AppContext } from '../../context.js';

const pending = new Set<Promise<unknown>>();

/** Run `work` in the background; failures are logged, never thrown. */
export function runInBackground(ctx: AppContext, what: string, work: () => Promise<unknown>): void {
  const p: Promise<unknown> = work()
    .catch((err) => ctx.log.warn({ err: String(err) }, `${what} failed`))
    .finally(() => pending.delete(p));
  pending.add(p);
}

/** Resolves once every background badge task started so far (and any they start) has finished. */
export async function settleBadgeTasks(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}
