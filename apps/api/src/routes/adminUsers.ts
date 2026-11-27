/**
 * Admin → Accounts and Challenges: list and inspect accounts, schedule/cancel/perform deletion,
 * clean up expired accounts, the audit trail, and the challenges overview. Admin only; the logic
 * lives in services/adminUsers.ts and services/adminChallenges.ts.
 */
import {
  adminChallengesQuerySchema,
  adminUsersQuerySchema,
  cleanupSchema,
  deleteAccountSchema,
  scheduleDeletionSchema,
} from '@gauntlet/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest, forbidden } from '../context.js';
import { listAdminChallenges } from '../services/adminChallenges.js';
import {
  accountDetail,
  cancelDeletion,
  cleanupExpired,
  deleteNow,
  listAccounts,
  readAudit,
  scheduleDeletion,
} from '../services/adminUsers.js';
import { getUser, isAdmin } from '../services/users.js';

const idSchema = z.string().uuid();

export function adminUserRoutes(app: FastifyInstance, ctx: AppContext) {
  const requireAdmin = async (req: FastifyRequest) => {
    await requireUser(ctx)(req, undefined as never);
    const me = await getUser(ctx, req.userId);
    if (!isAdmin(ctx, me)) throw forbidden('Only server admins can do that');
  };
  const auth = { preHandler: requireAdmin };
  const id = (raw: string) => {
    const r = idSchema.safeParse(raw);
    if (!r.success) throw badRequest('That is not an account id');
    return r.data;
  };

  app.get('/api/admin/users', auth, async (req) =>
    listAccounts(ctx, adminUsersQuerySchema.parse(req.query)),
  );

  app.post('/api/admin/users/cleanup-expired', auth, async (req) => {
    const { dryRun } = cleanupSchema.parse(req.body ?? {});
    return cleanupExpired(ctx, req.userId, dryRun ?? false);
  });

  app.get('/api/admin/audit', auth, async () => ({ entries: await readAudit(ctx) }));

  app.get<{ Params: { id: string } }>('/api/admin/users/:id', auth, async (req) =>
    accountDetail(ctx, id(req.params.id)),
  );

  app.post<{ Params: { id: string } }>(
    '/api/admin/users/:id/schedule-deletion',
    auth,
    async (req) => {
      const { reason } = scheduleDeletionSchema.parse(req.body ?? {});
      return scheduleDeletion(ctx, req.userId, id(req.params.id), reason);
    },
  );

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/cancel-deletion', auth, async (req) =>
    cancelDeletion(ctx, req.userId, id(req.params.id)),
  );

  app.delete<{ Params: { id: string } }>('/api/admin/users/:id', auth, async (req) => {
    const parsed = deleteAccountSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Type their name to confirm', 'confirm_required');
    return deleteNow(ctx, req.userId, id(req.params.id), parsed.data.confirm);
  });

  app.get('/api/admin/challenges', auth, async (req) =>
    listAdminChallenges(ctx, adminChallengesQuerySchema.parse(req.query)),
  );
}
