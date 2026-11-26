/**
 * Getting a stored notification onto people's devices, without any third-party account:
 *  - Web Push for browsers and the installed PWA, signed with this server's own VAPID keys. The
 *    browser vendor's push relay carries the (encrypted) message; nothing else is shared.
 *  - Android phones with no Google services poll instead (see the device routes in routes/push.ts).
 * registerPushDelivery() adds the web push channel to notify(); it is safe to call more than once.
 */
import { and, eq, lt } from 'drizzle-orm';
import webpush from 'web-push';
import type { AppContext } from '../context.js';
import { notifications, pushTargets } from '../db/schema.js';
import { addDeliveryChannel, type NotificationRow } from './notify.js';

/** One Web Push send. Replaceable in tests so nothing touches the network. */
export type WebPushSender = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: {
    TTL: number;
    vapidDetails: { subject: string; publicKey: string; privateKey: string };
  },
) => Promise<unknown>;

const realSender: WebPushSender = (sub, payload, options) =>
  webpush.sendNotification(sub, payload, options);
let sender: WebPushSender = realSender;

/** Test hook: swap the sender (pass null to restore the real one). */
export function setWebPushSender(fn: WebPushSender | null) {
  sender = fn ?? realSender;
}

/** The VAPID details to sign with, or null when the server operator hasn't set them. */
export function vapidFor(ctx: AppContext) {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT } = ctx.cfg;
  if (!publicKey || !privateKey) return null;
  // Push services want a contact URL; fall back to the public address of this server.
  const subject = VAPID_SUBJECT || ctx.cfg.PUBLIC_WEB_URL;
  return { publicKey, privateKey, subject };
}

const TTL_SECONDS = 24 * 3600;

/** Send one notification to every browser the person has turned notifications on in. */
async function deliverWebPush(ctx: AppContext, row: NotificationRow): Promise<void> {
  const vapid = vapidFor(ctx);
  if (!vapid) return;
  const targets = await ctx.db
    .select()
    .from(pushTargets)
    .where(and(eq(pushTargets.userId, row.userId), eq(pushTargets.kind, 'webpush')));
  if (!targets.length) return;
  const payload = JSON.stringify({
    id: row.id,
    title: row.title,
    body: row.body,
    url: row.url ?? '/notifications',
  });
  let delivered = false;
  await Promise.all(
    targets.map(async (t) => {
      const keys = t.keys;
      if (!keys?.p256dh || !keys.auth) return;
      try {
        await sender(
          { endpoint: t.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
          payload,
          {
            TTL: TTL_SECONDS,
            vapidDetails: vapid,
          },
        );
        delivered = true;
        await ctx.db
          .update(pushTargets)
          .set({ lastSeenAt: ctx.now() })
          .where(eq(pushTargets.id, t.id));
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // The browser says this subscription is gone (uninstalled, permission revoked, expired).
        if (status === 404 || status === 410) {
          await ctx.db.delete(pushTargets).where(eq(pushTargets.id, t.id));
        } else {
          ctx.log.warn({ err: String(err), status }, 'web push failed');
        }
      }
    }),
  );
  if (delivered)
    await ctx.db
      .update(notifications)
      .set({ deliveredAt: ctx.now() })
      .where(eq(notifications.id, row.id));
}

let registered = false;

/** Hook web push into notify(). Call once at startup (buildApp does). */
export function registerPushDelivery(): void {
  if (registered) return;
  registered = true;
  addDeliveryChannel(deliverWebPush);
}

/** Notifications older than this are deleted by the background cycle. */
export const NOTIFICATION_KEEP_DAYS = 60;

export async function pruneNotifications(ctx: AppContext): Promise<number> {
  const cutoff = new Date(ctx.now().getTime() - NOTIFICATION_KEEP_DAYS * 86_400_000);
  const gone = await ctx.db
    .delete(notifications)
    .where(lt(notifications.createdAt, cutoff))
    .returning({ id: notifications.id });
  return gone.length;
}
