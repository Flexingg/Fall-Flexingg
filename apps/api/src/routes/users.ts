import { userSearchSchema, type ProfileResponse, type UserCard } from '@gauntlet/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { notFound } from '../context.js';
import { canSeeUser, searchPublicUsers, toCards } from '../services/privacy.js';
import { getUsers } from '../services/users.js';
import { getProfile } from '../services/profile.js';

export function userRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireUser(ctx) };

  /** Find public people by name or @handle. */
  app.get(
    '/api/users/search',
    { ...auth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req): Promise<UserCard[]> => {
      const { q } = userSearchSchema.parse(req.query);
      return searchPublicUsers(ctx, req.userId, q);
    },
  );

  app.get<{ Params: { id: string } }>('/api/users/:id', auth, async (req): Promise<UserCard> => {
    const id = req.params.id;
    const u = /^[0-9a-f-]{36}$/i.test(id) ? (await getUsers(ctx, [id])).get(id) : undefined;
    if (!u || !(await canSeeUser(ctx, req.userId, u))) throw notFound('Person not found');
    return (await toCards(ctx, req.userId, [u]))[0]!;
  });

  /** A profile: record, trophies, and (if they share them, or it's you) all-time stats. */
  app.get<{ Params: { id: string } }>(
    '/api/users/:id/profile',
    auth,
    async (req): Promise<ProfileResponse> => getProfile(ctx, req.userId, req.params.id),
  );
}
