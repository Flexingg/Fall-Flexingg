/**
 * Admin routes for badge suggestions from the Garmin badge database: list, see the import status,
 * run it now, approve (creates a draft badge), dismiss, and re-check one. Admins only.
 */
import {
  badgeDraftSchema,
  importRunSchema,
  SUGGESTION_STATUSES,
  type AdminBadge,
  type BadgeImportStatus,
  type BadgeSuggestion,
} from '@gauntlet/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest, forbidden, HttpError, notFound } from '../context.js';
import { badgeSuggestions } from '../db/schema.js';
import { createDraftBadge } from '../services/badges/admin.js';
import {
  getImportStatus,
  importEnabled,
  listSuggestions,
  processSuggestion,
  startBadgeImport,
  toSuggestion,
} from '../services/badgeImport/runner.js';
import { getUser, isAdmin } from '../services/users.js';

const idParams = z.object({ id: z.string().uuid() });
const approveBody = z.object({ draft: badgeDraftSchema });

export function badgeSuggestionRoutes(app: FastifyInstance, ctx: AppContext) {
  const requireAdmin = async (req: FastifyRequest) => {
    await requireUser(ctx)(req, undefined as never);
    const me = await getUser(ctx, req.userId);
    if (!isAdmin(ctx, me)) throw forbidden('Only server admins can do that');
  };
  const auth = { preHandler: requireAdmin };
  const audit = (req: FastifyRequest, what: string, extra: object = {}) =>
    ctx.log.info({ adminId: req.userId, ...extra }, `admin: ${what}`);
  const needEnabled = () => {
    if (!importEnabled(ctx))
      throw new HttpError(
        409,
        'Badge suggestions are off. Set ANTHROPIC_API_KEY on the server to turn them on.',
        'import_disabled',
      );
  };
  const load = async (id: string) => {
    const [row] = await ctx.db.select().from(badgeSuggestions).where(eq(badgeSuggestions.id, id));
    if (!row) throw notFound('Suggestion not found');
    return row;
  };

  app.get(
    '/api/admin/badge-suggestions',
    auth,
    async (req): Promise<{ suggestions: BadgeSuggestion[] }> => {
      const q = z
        .object({ status: z.enum(SUGGESTION_STATUSES).optional() })
        .safeParse(req.query ?? {});
      if (!q.success) throw badRequest('Unknown status');
      audit(req, 'list badge suggestions');
      return { suggestions: await listSuggestions(ctx, q.data.status) };
    },
  );

  app.get('/api/admin/badge-suggestions/status', auth, async (): Promise<BadgeImportStatus> =>
    getImportStatus(ctx),
  );

  app.post('/api/admin/badge-suggestions/run', auth, async (req, reply) => {
    needEnabled();
    const body = importRunSchema.parse(req.body ?? {});
    const run = await startBadgeImport(ctx, body);
    if (!run.started)
      throw new HttpError(409, 'A badge check is already running', 'import_running');
    audit(req, 'badge import started', body);
    return reply.code(202).send({ started: true });
  });

  app.post(
    '/api/admin/badge-suggestions/:id/approve',
    auth,
    async (req): Promise<{ badge: AdminBadge }> => {
      const { id } = idParams.parse(req.params);
      const { draft } = approveBody.parse(req.body);
      const row = await load(id);
      if (row.status === 'approved')
        throw new HttpError(409, 'That suggestion is already approved', 'already_approved');
      const badge = await createDraftBadge(ctx, draft, 'garmin', row.sourceRef);
      await ctx.db
        .update(badgeSuggestions)
        .set({ status: 'approved', badgeKey: badge.key, draft, decidedAt: ctx.now() })
        .where(eq(badgeSuggestions.id, id));
      audit(req, 'badge suggestion approved', { id, key: badge.key });
      return { badge };
    },
  );

  app.post(
    '/api/admin/badge-suggestions/:id/dismiss',
    auth,
    async (req): Promise<{ suggestion: BadgeSuggestion }> => {
      const { id } = idParams.parse(req.params);
      const row = await load(id);
      if (row.status === 'approved')
        throw new HttpError(409, 'That suggestion is already approved', 'already_approved');
      const [updated] = await ctx.db
        .update(badgeSuggestions)
        .set({ status: 'dismissed', decidedAt: ctx.now() })
        .where(eq(badgeSuggestions.id, id))
        .returning();
      audit(req, 'badge suggestion dismissed', { id });
      return { suggestion: toSuggestion(updated!) };
    },
  );

  app.post(
    '/api/admin/badge-suggestions/:id/retry',
    auth,
    async (req): Promise<{ suggestion: BadgeSuggestion }> => {
      needEnabled();
      const { id } = idParams.parse(req.params);
      const row = await load(id);
      if (row.status === 'approved')
        throw new HttpError(409, 'That suggestion is already approved', 'already_approved');
      // A dismissed one asked to be re-checked comes back into the list.
      if (row.status === 'dismissed')
        await ctx.db
          .update(badgeSuggestions)
          .set({ status: 'pending' })
          .where(eq(badgeSuggestions.id, id));
      const o = await processSuggestion(ctx, {
        ...row,
        status: row.status === 'dismissed' ? 'pending' : row.status,
      });
      if (o.outcome === 'auth_error')
        throw new HttpError(409, `${o.error}. Check ANTHROPIC_API_KEY.`, 'import_auth');
      audit(req, 'badge suggestion re-checked', { id });
      return { suggestion: toSuggestion(await load(id)) };
    },
  );
}
