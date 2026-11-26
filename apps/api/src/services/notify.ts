/**
 * One place every feature sends notifications through. notify() checks the person's preferences,
 * stores the notification (the in-app list reads these), then hands it to every registered delivery
 * channel (web push, Android device polling, ...). Channels register themselves at startup with
 * addDeliveryChannel(); a failing channel never breaks the caller.
 */
import { wantsNotification, type NotificationKind } from '@gauntlet/shared';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { notifications, users } from '../db/schema.js';

export type NotificationRow = typeof notifications.$inferSelect;

export interface NotifyInput {
  kind: NotificationKind;
  title: string;
  body: string;
  /** In-app path to open, e.g. "/c/<id>". */
  url?: string | null;
  payload?: Record<string, unknown>;
}

type DeliveryChannel = (ctx: AppContext, row: NotificationRow) => Promise<void>;
const channels: DeliveryChannel[] = [];

export function addDeliveryChannel(channel: DeliveryChannel): void {
  channels.push(channel);
}

/** Store and deliver one notification. Returns the stored row, or null if the person opted out. */
export async function notify(
  ctx: AppContext,
  userId: string,
  input: NotifyInput,
): Promise<NotificationRow | null> {
  const [u] = await ctx.db
    .select({ prefs: users.notificationPrefs, isDemo: users.isDemo })
    .from(users)
    .where(eq(users.id, userId));
  if (!u || u.isDemo || !wantsNotification(u.prefs, input.kind)) return null;
  const [row] = await ctx.db
    .insert(notifications)
    .values({
      userId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      url: input.url ?? null,
      payload: input.payload ?? {},
    })
    .returning();
  for (const channel of channels) {
    await channel(ctx, row!).catch((err) =>
      ctx.log.warn({ err: String(err), kind: input.kind }, 'notification delivery failed'),
    );
  }
  return row!;
}
