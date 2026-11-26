/**
 * The in-app notification list (the bell and /notifications) and the per-kind on/off choices.
 */
import {
  NOTIFICATION_KINDS,
  isNotificationKind,
  notificationKinds,
  notificationPrefsSchema,
  wantsNotification,
  type AppNotification,
  type NotificationPrefsResponse,
  type NotificationKind,
  type NotificationsPage,
  type WeeklyRecap,
  isWeekId,
} from '@gauntlet/shared';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../context.js';
import { notifications, users } from '../db/schema.js';
import { buildRecap } from '../services/recap.js';
import { demoBlocked } from '../services/users.js';

const PAGE_SIZE = 30;

export function toAppNotification(r: typeof notifications.$inferSelect): AppNotification {
  return {
    id: r.id,
    kind: r.kind as NotificationKind,
    title: r.title,
    body: r.body,
    url: r.url,
    createdAt: r.createdAt.toISOString(),
    read: r.readAt != null,
  };
}

export function notificationRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireUser(ctx) };

  app.get('/api/notifications', auth, async (req): Promise<NotificationsPage> => {
    const { before } = z.object({ before: z.string().datetime().optional() }).parse(req.query);
    const rows = await ctx.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, req.userId),
          before ? lt(notifications.createdAt, new Date(before)) : undefined,
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(PAGE_SIZE);
    return {
      items: rows.map(toAppNotification),
      nextBefore: rows.length === PAGE_SIZE ? rows[rows.length - 1]!.createdAt.toISOString() : null,
    };
  });

  app.get('/api/notifications/unread-count', auth, async (req) => {
    const [row] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, req.userId), isNull(notifications.readAt)));
    return { count: row?.n ?? 0 };
  });

  app.post('/api/notifications/read-all', auth, async (req) => {
    await ctx.db
      .update(notifications)
      .set({ readAt: ctx.now() })
      .where(and(eq(notifications.userId, req.userId), isNull(notifications.readAt)));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/notifications/:id/read', auth, async (req) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw notFound('Notification not found');
    const [mine] = await ctx.db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.id, id.data), eq(notifications.userId, req.userId)));
    if (!mine) throw notFound('Notification not found');
    await ctx.db
      .update(notifications)
      .set({ readAt: ctx.now() })
      .where(and(eq(notifications.id, id.data), isNull(notifications.readAt)));
    return { ok: true };
  });

  // ---------- Preferences ----------

  async function prefsFor(userId: string): Promise<NotificationPrefsResponse> {
    const [u] = await ctx.db
      .select({ prefs: users.notificationPrefs })
      .from(users)
      .where(eq(users.id, userId));
    return {
      kinds: notificationKinds.map((kind) => ({
        kind,
        label: NOTIFICATION_KINDS[kind].label,
        enabled: wantsNotification(u?.prefs ?? {}, kind),
      })),
    };
  }

  app.get('/api/me/notification-prefs', auth, (req) => prefsFor(req.userId));

  app.put('/api/me/notification-prefs', auth, async (req) => {
    if (req.isDemo) throw demoBlocked();
    const { prefs } = notificationPrefsSchema.parse(req.body);
    const clean: Partial<Record<NotificationKind, boolean>> = {};
    for (const [k, v] of Object.entries(prefs)) {
      if (!isNotificationKind(k)) throw badRequest(`Unknown notification type: ${k}`);
      clean[k] = v;
    }
    // Merge, so a client that only sends what changed doesn't reset the rest.
    await ctx.db
      .update(users)
      .set({
        notificationPrefs: sql`${users.notificationPrefs} || ${JSON.stringify(clean)}::jsonb`,
      })
      .where(eq(users.id, req.userId));
    return prefsFor(req.userId);
  });

  // ---------- Weekly recap ----------

  /** One week (Monday to Sunday), worked out from the stored daily data. */
  app.get<{ Params: { week: string } }>(
    '/api/me/recap/:week',
    auth,
    async (req): Promise<WeeklyRecap> => {
      if (!isWeekId(req.params.week)) throw badRequest('That is not a week, try 2026-W48.');
      return buildRecap(ctx, req.userId, req.params.week);
    },
  );
}
