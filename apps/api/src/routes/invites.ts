import { createInviteSchema, type Invite, type InvitePreview } from '@gauntlet/shared';
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest, forbidden, HttpError, notFound } from '../context.js';
import { inviteCode } from '../crypto.js';
import { challengeParticipants, feedEvents, invites } from '../db/schema.js';
import {
  challengeMetricDef,
  challengeStatus,
  getChallenge,
  getParticipants,
} from '../services/challenges.js';
import { befriend } from '../services/friends.js';
import { syncUser } from '../services/sync.js';
import { getUser, toPublicUser } from '../services/users.js';

const INVITE_TTL_DAYS = 14;

export function inviteRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireUser(ctx) };

  app.post('/api/invites', auth, async (req): Promise<Invite> => {
    const body = createInviteSchema.parse(req.body);
    if (body.kind === 'challenge') {
      if (!body.challengeId) throw badRequest('challengeId is required');
      const ch = await getChallenge(ctx, body.challengeId);
      const parts = await getParticipants(ctx, ch.id);
      if (!parts.some((p) => p.userId === req.userId && p.state === 'joined'))
        throw forbidden('Join the challenge first');
      if (challengeStatus(ctx, ch) === 'completed') throw badRequest('That challenge is over');
    }
    // Reuse a live link instead of minting a new one every time.
    const [existing] = await ctx.db
      .select()
      .from(invites)
      .where(
        and(
          eq(invites.ownerId, req.userId),
          eq(invites.kind, body.kind),
          body.challengeId ? eq(invites.challengeId, body.challengeId) : eq(invites.kind, 'friend'),
          gt(invites.expiresAt, new Date(ctx.now().getTime() + 86_400_000)),
        ),
      );
    const row =
      existing ??
      (
        await ctx.db
          .insert(invites)
          .values({
            code: inviteCode(),
            ownerId: req.userId,
            kind: body.kind,
            challengeId: body.challengeId ?? null,
            expiresAt: new Date(ctx.now().getTime() + INVITE_TTL_DAYS * 86_400_000),
          })
          .returning()
      )[0]!;
    return {
      code: row.code,
      kind: row.kind,
      url: `${ctx.cfg.PUBLIC_WEB_URL.replace(/\/$/, '')}/j/${row.code}`,
      expiresAt: row.expiresAt.toISOString(),
    };
  });

  /** Public: lets the landing page show who invited you before you sign in. */
  app.get<{ Params: { code: string } }>(
    '/api/invites/:code',
    async (req): Promise<InvitePreview> => {
      const inv = await liveInvite(ctx, req.params.code);
      const owner = await getUser(ctx, inv.ownerId);
      const preview: InvitePreview = { code: inv.code, kind: inv.kind, from: toPublicUser(owner) };
      if (inv.challengeId) {
        const ch = await getChallenge(ctx, inv.challengeId);
        preview.challenge = {
          id: ch.id,
          name: ch.name,
          metricLabel: challengeMetricDef(ch).label,
          startDate: ch.startDate,
          endDate: ch.endDate,
        };
      }
      return preview;
    },
  );

  app.post<{ Params: { code: string } }>('/api/invites/:code/accept', auth, async (req) => {
    const inv = await liveInvite(ctx, req.params.code);
    if (inv.ownerId === req.userId) return { ok: true, challengeId: inv.challengeId };
    await befriend(ctx, inv.ownerId, req.userId, inv.ownerId);
    if (inv.challengeId) {
      const ch = await getChallenge(ctx, inv.challengeId);
      if (challengeStatus(ctx, ch) === 'completed')
        throw badRequest('That challenge is already over');
      const [inserted] = await ctx.db
        .insert(challengeParticipants)
        .values({ challengeId: ch.id, userId: req.userId, state: 'joined', invitedBy: inv.ownerId })
        .onConflictDoUpdate({
          target: [challengeParticipants.challengeId, challengeParticipants.userId],
          set: { state: 'joined' },
        })
        .returning();
      if (inserted) {
        await ctx.db
          .insert(feedEvents)
          .values({ actorId: req.userId, challengeId: ch.id, kind: 'joined', payload: {} });
        void syncUser(ctx, req.userId).catch(() => undefined);
      }
    }
    return { ok: true, challengeId: inv.challengeId };
  });
}

async function liveInvite(ctx: AppContext, code: string) {
  const [inv] = await ctx.db.select().from(invites).where(eq(invites.code, code.toLowerCase()));
  if (!inv) throw notFound('Invite not found');
  if (inv.expiresAt < ctx.now())
    throw new HttpError(410, 'This invite has expired. Ask for a new link.', 'invite_expired');
  return inv;
}
