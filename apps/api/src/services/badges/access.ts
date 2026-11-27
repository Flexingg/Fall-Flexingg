/**
 * Whose badges a viewer may open: themselves, or someone they can see who shares their stats
 * (the same rule as a profile's numbers). Anyone else is a 404, like any hidden profile.
 */
import type { AppContext } from '../../context.js';
import { notFound } from '../../context.js';
import { canSeeUser } from '../privacy.js';
import { getUsers } from '../users.js';

const isId = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

export async function badgeTargetFor(
  ctx: AppContext,
  viewerId: string,
  id: string,
): Promise<string> {
  if (id === viewerId) return viewerId;
  const u = isId(id) ? (await getUsers(ctx, [id])).get(id) : undefined;
  if (!u || !(await canSeeUser(ctx, viewerId, u)) || !u.shareProfileStats)
    throw notFound('Person not found');
  return u.id;
}
