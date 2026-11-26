/**
 * Push setup. Browsers register a Web Push subscription; the Android app registers a device and
 * polls (it has no Google services to receive pushes with). The device token is shown once and
 * only its SHA-256 is stored, like a password.
 */
import {
  deviceRegisterSchema,
  deviceRevokeSchema,
  webPushSubscribeSchema,
  webPushUnsubscribeSchema,
  type DevicePollResponse,
  type NotificationKind,
  type PushConfig,
} from '@gauntlet/shared';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../context.js';
import { randomToken, sha256 } from '../crypto.js';
import { notifications, pushTargets } from '../db/schema.js';
import { vapidFor } from '../services/push.js';
import { demoBlocked } from '../services/users.js';

const POLL_BATCH = 50;

export function pushRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireUser(ctx) };

  app.get('/api/push/config', auth, async (): Promise<PushConfig> => {
    const vapid = vapidFor(ctx);
    return { webPush: vapid ? { publicKey: vapid.publicKey } : null };
  });

  // ---------- Browsers (Web Push) ----------

  app.post('/api/push/webpush', auth, async (req) => {
    if (req.isDemo) throw demoBlocked();
    if (!vapidFor(ctx))
      throw new HttpError(409, "Browser notifications aren't set up on this server.", 'push_off');
    const { subscription, label } = webPushSubscribeSchema.parse(req.body);
    await ctx.db
      .insert(pushTargets)
      .values({
        userId: req.userId,
        kind: 'webpush',
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        label: label ?? null,
        lastSeenAt: ctx.now(),
      })
      .onConflictDoUpdate({
        target: pushTargets.endpoint,
        // The same browser signing in as someone else takes the subscription over.
        set: { userId: req.userId, keys: subscription.keys, label: label ?? null },
      });
    return { ok: true };
  });

  app.delete('/api/push/webpush', auth, async (req) => {
    const { endpoint } = webPushUnsubscribeSchema.parse(req.body);
    await ctx.db
      .delete(pushTargets)
      .where(
        and(
          eq(pushTargets.userId, req.userId),
          eq(pushTargets.kind, 'webpush'),
          eq(pushTargets.endpoint, endpoint),
        ),
      );
    return { ok: true };
  });

  // ---------- The Android app (polling) ----------

  app.post('/api/push/device', auth, async (req) => {
    if (req.isDemo) throw demoBlocked();
    const { label } = deviceRegisterSchema.parse(req.body ?? {});
    const token = randomToken(32);
    await ctx.db.insert(pushTargets).values({
      userId: req.userId,
      kind: 'device',
      endpoint: sha256(token),
      label: label ?? 'Android app',
      // Notifications from now on; older ones stay in the app's list.
      lastSeenAt: sql`now()`,
    });
    return { token };
  });

  // POST rather than DELETE: Android's native HTTP handles bodies on POST most reliably.
  app.post('/api/push/device/revoke', auth, async (req) => {
    const { token } = deviceRevokeSchema.parse(req.body);
    await ctx.db
      .delete(pushTargets)
      .where(
        and(
          eq(pushTargets.userId, req.userId),
          eq(pushTargets.kind, 'device'),
          eq(pushTargets.endpoint, sha256(token)),
        ),
      );
    return { ok: true };
  });

  /**
   * Called by the phone's background job with only its device token, so it never competes with the
   * app for the rotating refresh token. Each device keeps its own place in the list.
   */
  app.get('/api/push/device/poll', async (req): Promise<DevicePollResponse> => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Device ') ? header.slice(7).trim() : '';
    const [target] = token
      ? await ctx.db
          .select()
          .from(pushTargets)
          .where(and(eq(pushTargets.kind, 'device'), eq(pushTargets.endpoint, sha256(token))))
      : [];
    if (!target) throw new HttpError(401, 'Unknown device', 'bad_device');
    const since = target.lastSeenAt ?? target.createdAt;
    const rows = await ctx.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, target.userId),
          isNull(notifications.readAt),
          // Compare at millisecond precision, the precision the cursor is stored with.
          sql`date_trunc('milliseconds', ${notifications.createdAt}) > ${since.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(asc(notifications.createdAt))
      .limit(POLL_BATCH);
    if (rows.length)
      await ctx.db
        .update(pushTargets)
        .set({ lastSeenAt: rows[rows.length - 1]!.createdAt })
        .where(eq(pushTargets.id, target.id));
    return {
      notifications: rows.map((r) => ({
        id: r.id,
        kind: r.kind as NotificationKind,
        title: r.title,
        body: r.body,
        url: r.url,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });
}
