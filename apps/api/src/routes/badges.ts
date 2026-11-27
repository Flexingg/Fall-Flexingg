/**
 * Badges for people: your catalog (with progress and what's new), someone else's, one badge's detail,
 * marking badges as seen, and choosing the three pinned to your profile. Another person's badges
 * follow the same rule as their profile stats: they must be able to be seen at all (canSeeUser) and
 * share their stats, otherwise it's a 404 like any hidden profile.
 */
import { markSeenSchema, showcaseSchema } from '@gauntlet/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { loadImage } from '../services/badges/admin.js';
import { notFound } from '../context.js';
import {
  buildCatalog,
  buildDetail,
  buildUnseen,
  markSeen,
  setShowcase,
} from '../services/badges/views.js';
import { canSeeUser } from '../services/privacy.js';
import { getUsers } from '../services/users.js';

const isId = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

export function badgeRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireUser(ctx) };

  /** Whose badges the viewer may open: themselves, or someone visible who shares their stats. */
  async function targetFor(viewerId: string, id: string): Promise<string> {
    if (id === viewerId) return viewerId;
    const u = isId(id) ? (await getUsers(ctx, [id])).get(id) : undefined;
    if (!u || !(await canSeeUser(ctx, viewerId, u)) || !u.shareProfileStats)
      throw notFound('Person not found');
    return u.id;
  }

  app.get('/api/badges', auth, async (req) => buildCatalog(ctx, req.userId, req.userId));

  app.get('/api/badges/unseen', auth, async (req) => buildUnseen(ctx, req.userId));

  app.post('/api/badges/seen', auth, async (req) => {
    const { keys } = markSeenSchema.parse(req.body ?? {});
    await markSeen(ctx, req.userId, keys);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/users/:id/badges', auth, async (req) =>
    buildCatalog(ctx, req.userId, await targetFor(req.userId, req.params.id)),
  );

  app.get<{ Params: { key: string }; Querystring: { user?: string } }>(
    '/api/badges/:key',
    auth,
    async (req) => {
      const who = z.string().optional().parse(req.query.user);
      const target = who ? await targetFor(req.userId, who) : req.userId;
      return buildDetail(ctx, req.userId, req.params.key, target);
    },
  );

  app.put('/api/me/showcase', auth, async (req) => {
    const { keys } = showcaseSchema.parse(req.body ?? {});
    return { showcase: await setShowcase(ctx, req.userId, keys) };
  });

  /** Uploaded badge art: public, immutable, and locked down so an SVG can never run anything. */
  app.get<{ Params: { id: string } }>('/api/badge-images/:id', async (req, reply) => {
    const img = await loadImage(ctx, req.params.id);
    if (!img) throw notFound('Image not found');
    return reply
      .header('Content-Type', img.mime)
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
      .header('X-Content-Type-Options', 'nosniff')
      .send(img.data);
  });
}
