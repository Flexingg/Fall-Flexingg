/**
 * The backfill queue. Publishing a badge (or changing a live badge's rule) means quietly awarding
 * it to everyone who already qualifies, which scans every user. With ~140 drafts published at once
 * that must not run 140 scans in parallel, so badges wait in a queue and one runner works through
 * them one after another.
 *
 * The queue lives in server_state ('badge_backfill') so the admin page can show "Awarding… 12 of
 * 138" and so a restart in the middle does not lose the rest: the scheduler calls
 * resumeBadgeBackfill() each cycle and carries on. A badge only leaves the queue once its backfill
 * finished, and backfillBadge is idempotent, so redoing the one that was interrupted is harmless.
 * Even a badge that never gets its backfill is still awarded: every live badge is checked on each
 * person's next sync (a normal, announced award rather than a quiet one).
 */
import type { BadgeBackfillStatus } from '@gauntlet/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { badgeDefinitions, serverState } from '../../db/schema.js';
import { backfillBadge } from './engine.js';
import { runInBackground } from './tasks.js';

const KEY = 'badge_backfill';

interface QueueState {
  queue: string[];
  done: number;
  total: number;
}

let runnerActive = false;

async function readState(ctx: AppContext): Promise<QueueState & { updatedAt: string | null }> {
  const [row] = await ctx.db.select().from(serverState).where(eq(serverState.key, KEY));
  const v = (row?.value ?? {}) as Partial<QueueState>;
  return {
    queue: Array.isArray(v.queue) ? v.queue : [],
    done: v.done ?? 0,
    total: v.total ?? 0,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

async function writeState(ctx: AppContext, v: QueueState): Promise<void> {
  await ctx.db
    .insert(serverState)
    .values({ key: KEY, value: v, updatedAt: ctx.now() })
    .onConflictDoUpdate({ target: serverState.key, set: { value: v, updatedAt: ctx.now() } });
}

export async function backfillStatus(ctx: AppContext): Promise<BadgeBackfillStatus> {
  const s = await readState(ctx);
  const names = s.queue[0]
    ? await ctx.db
        .select({ name: badgeDefinitions.name })
        .from(badgeDefinitions)
        .where(eq(badgeDefinitions.key, s.queue[0]))
    : [];
  return {
    // A non-empty queue counts as running even in the moment between a restart and the resume.
    running: s.queue.length > 0,
    done: s.done,
    total: s.total,
    current: names[0]?.name ?? null,
    updatedAt: s.updatedAt,
  };
}

/** Add badges to the queue (skipping ones already waiting) and make sure the runner is going. */
export async function enqueueBackfill(ctx: AppContext, keys: string[]): Promise<void> {
  if (!keys.length) return;
  const s = await readState(ctx);
  const fresh = keys.filter((k) => !s.queue.includes(k));
  if (fresh.length) {
    const idle = s.queue.length === 0;
    await writeState(ctx, {
      queue: [...s.queue, ...fresh],
      // A new run starts counting from zero; adding to a running one extends it.
      done: idle ? 0 : s.done,
      total: (idle ? 0 : s.total) + fresh.length,
    });
  }
  startRunner(ctx);
}

/** Called by the scheduler: pick the queue back up after a restart. */
export async function resumeBadgeBackfill(ctx: AppContext): Promise<void> {
  if (runnerActive) return;
  if ((await readState(ctx)).queue.length) startRunner(ctx);
}

function startRunner(ctx: AppContext): void {
  if (runnerActive) return;
  runnerActive = true;
  runInBackground(ctx, 'badge backfill queue', async () => {
    try {
      for (;;) {
        const s = await readState(ctx);
        const key = s.queue[0];
        if (!key) break;
        try {
          await backfillBadge(ctx, key);
        } catch (err) {
          // Skip a broken one rather than stall the rest; its holders still get it on their next sync.
          ctx.log.warn({ err: String(err), key }, 'badge backfill failed');
        }
        // Re-read: more badges may have been queued while this one ran.
        const after = await readState(ctx);
        const queue = after.queue.filter((k) => k !== key);
        await writeState(ctx, { queue, done: after.done + 1, total: after.total });
      }
    } finally {
      runnerActive = false;
    }
  });
}

/** Publish every draft (or just the drafts among `keys`), then queue their backfills. Returns how many went live. */
export async function publishAllDrafts(ctx: AppContext, keys?: string[]): Promise<number> {
  if (keys && !keys.length) return 0;
  const now = ctx.now();
  // Drafts only: "publish selected" must never revive a retired badge or touch a live one.
  const published = await ctx.db
    .update(badgeDefinitions)
    .set({ status: 'live', publishedAt: now, retiredAt: null, updatedAt: now })
    .where(
      and(
        eq(badgeDefinitions.status, 'draft'),
        keys ? inArray(badgeDefinitions.key, keys) : undefined,
      ),
    )
    .returning({ key: badgeDefinitions.key });
  await enqueueBackfill(
    ctx,
    published.map((p) => p.key),
  );
  return published.length;
}
