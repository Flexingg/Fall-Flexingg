/**
 * Admin → Badges: list, create drafts, edit, preview who would earn one, publish, retire, delete
 * drafts, and upload badge art. Admin only, like the rest of /api/admin, and written to the log.
 */
import { badgeDraftSchema, publishAllSchema } from '@gauntlet/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest, forbidden } from '../context.js';
import {
  createDraftBadge,
  deleteDraftBadge,
  IMAGE_MAX_BYTES,
  IMAGE_MIMES,
  listAdminBadges,
  publishBadge,
  retireBadge,
  saveImage,
  updateBadge,
} from '../services/badges/admin.js';
import { previewDraft } from '../services/badges/engine.js';
import { backfillStatus, publishAllDrafts } from '../services/badges/publishAll.js';
import { getUser, isAdmin } from '../services/users.js';

const keySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);

export function adminBadgeRoutes(app: FastifyInstance, ctx: AppContext) {
  const requireAdmin = async (req: FastifyRequest) => {
    await requireUser(ctx)(req, undefined as never);
    const me = await getUser(ctx, req.userId);
    if (!isAdmin(ctx, me)) throw forbidden('Only server admins can do that');
  };
  const auth = { preHandler: requireAdmin };
  const audit = (req: FastifyRequest, what: string, extra: object = {}) =>
    ctx.log.info({ adminId: req.userId, ...extra }, `admin: ${what}`);

  // Raw image uploads (the other way in is base64 JSON).
  app.addContentTypeParser(
    [...IMAGE_MIMES],
    { parseAs: 'buffer', bodyLimit: IMAGE_MAX_BYTES + 1024 },
    (_req, body, done) => done(null, body),
  );

  app.get('/api/admin/badges', auth, async (req) => {
    audit(req, 'list badges');
    return listAdminBadges(ctx);
  });

  /** Progress of the quiet "award everyone who already qualifies" runs that follow publishing. */
  app.get('/api/admin/badges/backfill', auth, async () => backfillStatus(ctx));

  /** Publish every draft (or `keys`). Awarding happens one badge after another in the background. */
  app.post('/api/admin/badges/publish-all', auth, async (req) => {
    const { keys } = publishAllSchema.parse(req.body ?? {});
    const published = await publishAllDrafts(ctx, keys);
    audit(req, 'publish all badges', { published });
    return { published };
  });

  app.post('/api/admin/badges', auth, async (req, reply) => {
    const draft = badgeDraftSchema.parse(req.body);
    audit(req, 'create badge', { key: draft.key });
    const badge = await createDraftBadge(ctx, draft, 'admin');
    reply.code(201);
    return badge;
  });

  app.post('/api/admin/badges/preview', auth, async (req) => {
    const draft = badgeDraftSchema.parse(req.body);
    return previewDraft(ctx, draft);
  });

  // Registered before /:key routes so "images" is never read as a key.
  app.post('/api/admin/badges/images', auth, async (req, reply) => {
    let mime: string;
    let data: Buffer;
    if (Buffer.isBuffer(req.body)) {
      mime = String(req.headers['content-type'] ?? '')
        .split(';')[0]!
        .trim();
      data = req.body;
    } else {
      const b = z
        .object({ mime: z.string(), data: z.string().max(IMAGE_MAX_BYTES * 2) })
        .safeParse(req.body);
      if (!b.success)
        throw badRequest('Send the image as raw bytes or as { mime, data } in base64.');
      mime = b.data.mime;
      data = Buffer.from(b.data.data.replace(/^data:[^,]*,/, ''), 'base64');
    }
    const saved = await saveImage(ctx, mime, data);
    audit(req, 'upload badge image', { url: saved.url });
    reply.code(201);
    return saved;
  });

  app.put<{ Params: { key: string } }>('/api/admin/badges/:key', auth, async (req) => {
    const key = keySchema.parse(req.params.key);
    const draft = badgeDraftSchema.parse(req.body);
    audit(req, 'edit badge', { key });
    return updateBadge(ctx, key, draft);
  });

  app.post<{ Params: { key: string } }>('/api/admin/badges/:key/publish', auth, async (req) => {
    const key = keySchema.parse(req.params.key);
    audit(req, 'publish badge', { key });
    return publishBadge(ctx, key);
  });

  app.post<{ Params: { key: string } }>('/api/admin/badges/:key/retire', auth, async (req) => {
    const key = keySchema.parse(req.params.key);
    audit(req, 'retire badge', { key });
    return retireBadge(ctx, key);
  });

  app.delete<{ Params: { key: string } }>('/api/admin/badges/:key', auth, async (req, reply) => {
    const key = keySchema.parse(req.params.key);
    audit(req, 'delete badge draft', { key });
    await deleteDraftBadge(ctx, key);
    return reply.code(204).send();
  });
}
