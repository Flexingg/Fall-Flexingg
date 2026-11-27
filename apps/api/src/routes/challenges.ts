import {
  addDays,
  computeStandings,
  createChallengeSchema,
  DATES_FIXED_MESSAGE,
  eventsQuerySchema,
  featureChallengeSchema,
  joinChallengeSchema,
  needsWeightGoal,
  type ParticipantParams,
  daysBetween,
  isCustomMetric,
  metricDef,
  minDate,
  liftExercise,
  progressSeries,
  soloGraph,
  soloScoring,
  rematchName,
  respondChallengeSchema,
  updateChallengeSchema,
  todayIn,
  validateRules,
  type ChallengeEventsResponse,
  type ChallengeProgress,
  type EventGroup,
  type ChallengeResult,
  type ChallengeStatus,
  type DiscoverResponse,
  type MetricAggregate,
  type MetricKey,
} from '@gauntlet/shared';
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest, forbidden, notFound } from '../context.js';
import { challengeParticipants, challenges, feedEvents } from '../db/schema.js';
import { chooseTeam, cloneTeams, getTeams, insertTeams } from '../services/teams.js';
import {
  assertCanView,
  challengeStatus,
  challengeToday,
  computeChallengeStandings,
  loadSeries,
  scoringRules,
  soloFor,
  getChallenge,
  getParticipants,
  listForUser,
  loadDetail,
  paramsOf,
  summarize,
} from '../services/challenges.js';
import { eventGroupFor } from '../services/events.js';
import { friendIds } from '../services/friends.js';
import { notifyChallengeInvites } from '../services/notifyEvents.js';
import { syncUser } from '../services/sync.js';
import {
  getUser,
  getUsers,
  isAdmin,
  isValidTimeZone,
  sparkyToken,
  toPublicUser,
} from '../services/users.js';

const MAX_DAYS = 366;
const DISCOVER_LIMIT = 30;
/** Lines drawn on the progress graph besides the viewer's. */
const PROGRESS_LINES = 7;
/** People whose events one request reads from SparkyFitness (4 at a time). */
const EVENTS_PER_REQUEST = 12;

export function challengeRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireUser(ctx) };

  app.get<{ Querystring: { status?: ChallengeStatus } }>('/api/challenges', auth, async (req) => {
    const all = await listForUser(ctx, req.userId);
    return req.query.status ? all.filter((c) => c.status === req.query.status) : all;
  });

  app.post('/api/challenges', auth, async (req, reply) => {
    const body = createChallengeSchema.parse(req.body);
    if (!isValidTimeZone(body.timezone)) throw badRequest('Unknown time zone');
    if (daysBetween(body.startDate, body.endDate) + 1 > MAX_DAYS)
      throw badRequest('Challenges can last at most a year');
    const today = todayIn(body.timezone, ctx.now());
    if (body.endDate < today) throw badRequest('That challenge would already be over');

    let metric: MetricKey = body.metric;
    let custom: { label: string; unit: string | null } | null = null;
    let aggregate: MetricAggregate;
    let lowerIsBetter: boolean;
    if (isCustomMetric(metric)) {
      // Custom categories are per user in SparkyFitness; challenges match them by name.
      const me = await getUser(ctx, req.userId);
      const cats = await ctx.sparky.customCategories(sparkyToken(ctx, me));
      const cat = cats.find((c) => c.id === body.custom!.categoryId);
      if (!cat) throw badRequest('That custom metric was not found in SparkyFitness');
      metric = `custom:${cat.name.toLowerCase()}`;
      custom = { label: body.custom!.label, unit: body.custom!.unit ?? null };
      aggregate = body.custom!.aggregate;
      lowerIsBetter = body.custom!.lowerIsBetter;
    } else {
      const def = metricDef(metric);
      aggregate = def.aggregate;
      lowerIsBetter = def.lowerIsBetter;
      if (!def.scoring.includes(body.scoring))
        throw badRequest(`${def.label} can't be won that way. Pick another way to win.`);
    }
    let scoring = body.scoring;
    let goal = body.goal ?? null;
    if (body.solo) {
      if (body.inviteUserIds.length || body.visibility === 'public')
        throw badRequest('A solo challenge is just for you: no invites, and it stays private.');
      const kind = body.solo.kind;
      if (metricDef(metric).transform && kind !== 'target')
        throw badRequest(
          'That stat is already scored against your own starting point. Use "Hit a total" with it.',
        );
      if (kind === 'target' && aggregate === 'avg')
        throw badRequest(
          'A total only works for stats that add up (steps, distance…). Try a daily average.',
        );
      if (
        kind !== 'improve' &&
        metricDef(metric).transform !== 'weight_goal' &&
        !(goal && goal > 0)
      )
        throw badRequest(
          kind === 'streak' ? 'Set the daily target to hit.' : 'Set the number to aim for.',
        );
      if (
        kind === 'streak' &&
        body.solo.kind === 'streak' &&
        body.solo.days > daysBetween(body.startDate, body.endDate) + 1
      )
        throw badRequest('The streak is longer than the challenge.');
      scoring = soloScoring(kind, {
        heaviest: !!liftExercise(metric) && liftExercise(metric)!.prefix === 'lift_max:',
      });
      if (kind === 'improve') goal = null;
      // Weight challenges against yourself aim at 100% of your own target.
      if (metricDef(metric).transform === 'weight_goal') goal = 100;
    }
    if (body.solo && (body.teams || body.recurrence))
      throw badRequest('A solo challenge is just for you: no teams, and it does not repeat.');
    if (body.solo && body.stake)
      throw badRequest('A side bet needs someone to lose to. Solo challenges cannot have one.');
    const problem = validateRules({ scoring, aggregate, goal });
    if (problem) throw badRequest(problem);
    const params = checkParams(metric, body.params);

    if (body.visibility === 'public') {
      const me = await getUser(ctx, req.userId);
      if (me.visibility !== 'public')
        throw badRequest('Make your profile public to start a public challenge.', 'needs_public');
    }

    const friends = new Set(await friendIds(ctx, req.userId));
    const invitees = [...new Set(body.inviteUserIds)].filter((id) => id !== req.userId);
    const notFriends = invitees.filter((id) => !friends.has(id));
    if (notFriends.length)
      throw badRequest('You can only invite friends. Share the challenge link with anyone else.');

    // A recurring challenge is the first round of its own series.
    const newId = randomUUID();
    const id = await ctx.db.transaction(async (tx) => {
      const txCtx: AppContext = { ...ctx, db: tx as unknown as AppContext['db'] };
      const [ch] = await tx
        .insert(challenges)
        .values({
          id: newId,
          teamScoring: body.teams?.scoring ?? null,
          recurrence: body.recurrence ?? null,
          ...(body.recurrence ? { seriesId: newId, seriesRound: 1 } : {}),
          name: body.name,
          metric,
          customLabel: custom?.label ?? null,
          customUnit: custom?.unit ?? null,
          aggregate,
          lowerIsBetter,
          scoring,
          goal,
          solo: body.solo ?? null,
          startDate: body.startDate,
          endDate: body.endDate,
          timezone: body.timezone,
          createdBy: req.userId,
          visibility: body.visibility,
          showEvents: body.showEvents,
          stake: body.stake ?? null,
        })
        .returning({ id: challenges.id });
      const teamRows = body.teams ? await insertTeams(txCtx, ch!.id, body.teams.teams) : [];
      const myTeamId = teamRows[body.teams?.myTeam ?? 0]?.id ?? null;
      await tx.insert(challengeParticipants).values([
        {
          challengeId: ch!.id,
          userId: req.userId,
          state: 'joined' as const,
          params,
          teamId: myTeamId,
        },
        ...invitees.map((userId) => ({
          challengeId: ch!.id,
          userId,
          state: 'invited' as const,
          invitedBy: req.userId,
        })),
      ]);
      if (!body.solo)
        await tx.insert(feedEvents).values({
          actorId: req.userId,
          challengeId: ch!.id,
          kind: 'challenge_created',
          payload: {},
        });
      return ch!.id;
    });
    await notifyChallengeInvites(
      ctx,
      { id, name: body.name, solo: body.solo },
      req.userId,
      invitees,
    );
    // Pull the data the new challenge needs (custom metrics, older start dates).
    void syncUser(ctx, req.userId).catch(() => undefined);
    reply.code(201);
    return loadDetail(ctx, id, req.userId);
  });

  /** Public challenges anyone can join: featured first, then the busiest, then the newest. */
  app.get('/api/challenges/discover', auth, async (req): Promise<DiscoverResponse> => {
    const me = await getUser(ctx, req.userId);
    const joinedCount = sql<number>`(select count(*) from ${challengeParticipants} p
      where p.challenge_id = ${challenges.id} and p.state = 'joined')`;
    const rows = await ctx.db
      .select()
      .from(challenges)
      .where(
        and(
          eq(challenges.visibility, 'public'),
          isNull(challenges.finalizedAt),
          gte(challenges.endDate, addDays(todayIn('UTC', ctx.now()), -1)),
        ),
      )
      .orderBy(desc(challenges.featured), desc(joinedCount), desc(challenges.createdAt))
      .limit(DISCOVER_LIMIT);
    const list = await summarize(ctx, rows, req.userId);
    return {
      challenges: list.filter((c) => c.status !== 'completed'),
      canJoin: me.visibility === 'public',
    };
  });

  /** Join a public challenge without an invite. */
  app.post<{ Params: { id: string } }>('/api/challenges/:id/join', auth, async (req) => {
    const body = joinChallengeSchema.parse(req.body ?? {});
    const ch = await getChallenge(ctx, uuid(req.params.id));
    const parts = await getParticipants(ctx, ch.id);
    const mine = parts.find((p) => p.userId === req.userId);
    if (ch.visibility !== 'public' && !mine) throw notFound('Challenge not found');
    if (challengeStatus(ctx, ch) === 'completed') throw badRequest('That challenge is over');
    if (mine?.state === 'joined' && !body.params && !body.teamId)
      return loadDetail(ctx, ch.id, req.userId);
    const teamId = ch.teamScoring
      ? chooseTeam({
          teams: await getTeams(ctx, ch.id),
          started: challengeStatus(ctx, ch) !== 'upcoming',
          mine,
          wanted: body.teamId,
        })
      : null;
    const params = checkParams(ch.metric, body.params ?? (mine ? paramsOf(mine) : undefined));
    if (!mine) {
      const me = await getUser(ctx, req.userId);
      if (me.visibility !== 'public')
        throw badRequest(
          'Make your profile public to join public challenges (Me → Profile).',
          'needs_public',
        );
      if (parts.filter((p) => p.state === 'joined').length >= ch.maxParticipants)
        throw badRequest('That challenge is full');
    }
    await ctx.db
      .insert(challengeParticipants)
      .values({ challengeId: ch.id, userId: req.userId, state: 'joined', params, teamId })
      .onConflictDoUpdate({
        target: [challengeParticipants.challengeId, challengeParticipants.userId],
        set: { state: 'joined', params, teamId },
      });
    if (mine?.state !== 'joined')
      await ctx.db
        .insert(feedEvents)
        .values({ actorId: req.userId, challengeId: ch.id, kind: 'joined', payload: {} });
    void syncUser(ctx, req.userId).catch(() => undefined);
    return loadDetail(ctx, ch.id, req.userId);
  });

  /**
   * The creator can rename a challenge, make it public or private, and turn Show Events on or off.
   * Dates are fixed at creation (scores can't be shifted under people); Rematch runs it again.
   */
  app.patch<{ Params: { id: string } }>('/api/challenges/:id', auth, async (req) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    if ('startDate' in raw || 'endDate' in raw)
      throw badRequest(DATES_FIXED_MESSAGE, 'dates_fixed');
    const body = updateChallengeSchema.parse(raw);
    const ch = await getChallenge(ctx, uuid(req.params.id));
    if (ch.createdBy !== req.userId) throw forbidden('Only the creator can change a challenge');
    if (ch.finalizedAt) throw badRequest('That challenge is over');
    if (ch.solo && (body.visibility === 'public' || body.recurrence))
      throw badRequest(
        'A solo challenge is just for you, so it stays private and does not repeat.',
      );
    if (ch.solo && body.visibility === 'public')
      throw badRequest('A solo challenge is just for you, so it stays private.');
    if (body.visibility === 'public' && ch.visibility !== 'public') {
      const me = await getUser(ctx, req.userId);
      if (me.visibility !== 'public')
        throw badRequest('Make your profile public to make a challenge public.', 'needs_public');
    }
    if (body.stake !== undefined) {
      if (ch.solo && body.stake)
        throw badRequest('A side bet needs someone to lose to. Solo challenges cannot have one.');
      if (challengeStatus(ctx, ch) !== 'upcoming' && body.stake !== ch.stake)
        throw badRequest('The side bet can only be changed before the challenge starts.');
    }
    const visibility = body.visibility ?? ch.visibility;
    await ctx.db
      .update(challenges)
      .set({
        ...(body.name ? { name: body.name } : {}),
        visibility,
        // A challenge that leaves Discover can't stay pinned there.
        ...(visibility === 'private' ? { featured: false } : {}),
        ...(body.showEvents != null ? { showEvents: body.showEvents } : {}),
        ...(body.stake !== undefined ? { stake: body.stake, stakeSettledAt: null } : {}),
        // null stops repeating; a challenge that starts repeating becomes round 1 of a series.
        ...(body.recurrence !== undefined ? { recurrence: body.recurrence } : {}),
        ...(body.recurrence && !ch.seriesId ? { seriesId: ch.id, seriesRound: 1 } : {}),
      })
      .where(eq(challenges.id, ch.id));
    return loadDetail(ctx, ch.id, req.userId);
  });

  /** Server admins pin public challenges to the top of Discover. */
  app.patch<{ Params: { id: string } }>('/api/challenges/:id/featured', auth, async (req) => {
    const { featured } = featureChallengeSchema.parse(req.body);
    const me = await getUser(ctx, req.userId);
    if (!isAdmin(ctx, me)) throw forbidden('Only server admins can feature challenges');
    const ch = await getChallenge(ctx, uuid(req.params.id));
    if (ch.visibility !== 'public') throw badRequest('Only public challenges can be featured');
    await ctx.db.update(challenges).set({ featured }).where(eq(challenges.id, ch.id));
    return loadDetail(ctx, ch.id, req.userId);
  });

  app.get<{ Params: { id: string } }>('/api/challenges/:id', auth, async (req) =>
    loadDetail(ctx, uuid(req.params.id), req.userId),
  );

  /** Everyone's score day by day (top ranked plus you), worked out with the leaderboard's own rules. */
  app.get<{ Params: { id: string } }>(
    '/api/challenges/:id/progress',
    auth,
    async (req): Promise<ChallengeProgress> => {
      const ch = await getChallenge(ctx, uuid(req.params.id));
      const parts = await assertCanView(ctx, ch, req.userId, {
        allowPublic: true,
        allowAdmin: true,
      });
      const { byUser } = await loadSeries(ctx, ch, parts);
      const rules = scoringRules(ctx, ch);
      const everyone = [...byUser].map(([userId, days]) => ({ userId, days }));
      const ranked = computeStandings(rules, everyone);
      const shown = new Set(ranked.slice(0, PROGRESS_LINES).map((s) => s.userId));
      if (byUser.has(req.userId)) shown.add(req.userId);
      const { dates, series } = progressSeries(
        rules,
        everyone.filter((p) => shown.has(p.userId)),
      );
      const usersById = await getUsers(ctx, [...shown]);
      // Against yourself the graph is read against your goal: a reference line, and for "beat my past
      // self" the values are % change from your own past.
      let target: number | null = null;
      let valueKind: ChallengeProgress['valueKind'] = 'metric';
      let toPct: ((v: number) => number) | null = null;
      if (ch.solo) {
        const sp = await soloFor(ctx, ch, byUser);
        const g = soloGraph(ch.solo, ch.goal, sp?.baseline?.value ?? null);
        target = g.target;
        valueKind = g.valueKind;
        if (ch.solo.kind === 'improve' && sp?.baseline) {
          const base = sp.baseline.value;
          toPct = (v) => (v / base - 1) * 100;
        }
      }
      return {
        dates,
        series: ranked
          .filter((s) => shown.has(s.userId))
          .flatMap((s) => {
            const u = usersById.get(s.userId);
            const raw = series.find((x) => x.userId === s.userId)?.values;
            const values = raw && toPct ? raw.map((v) => (v == null ? null : toPct!(v))) : raw;
            return u && values
              ? [{ user: toPublicUser(u), rank: s.rank, isMe: s.userId === req.userId, values }]
              : [];
          }),
        target,
        valueKind,
        // Aiming lower (e.g. resting heart rate) flips the graph so up still means ahead.
        lowerIsBetter:
          ch.solo?.kind === 'improve' ? ch.solo.direction === 'down' : ch.lowerIsBetter,
        truncated: everyone.length > shown.size,
        total: everyone.length,
      };
    },
  );

  /**
   * What counted on one day, for challenges with Show Events on. Joined participants only, and
   * read live from each person's SparkyFitness (people who keep workouts private come back hidden).
   */
  app.get<{ Params: { id: string } }>(
    '/api/challenges/:id/events',
    { ...auth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req): Promise<ChallengeEventsResponse> => {
      const { date, userId } = eventsQuerySchema.parse(req.query);
      const ch = await getChallenge(ctx, uuid(req.params.id));
      const parts = await assertCanView(ctx, ch, req.userId, { allowPublic: true });
      if (parts.find((p) => p.userId === req.userId)?.state !== 'joined')
        throw forbidden('Join the challenge to see what counted');
      if (!ch.showEvents) throw forbidden('This challenge does not show events');
      if (date < ch.startDate || date > minDate(ch.endDate, challengeToday(ctx, ch)))
        throw badRequest('Pick a day the challenge has covered so far');

      const joined = new Set(parts.filter((p) => p.state === 'joined').map((p) => p.userId));
      let order: string[];
      if (userId) {
        if (!joined.has(userId)) throw notFound('That person is not in this challenge');
        order = [userId];
      } else {
        const { standings } = await computeChallengeStandings(ctx, ch, parts);
        order = standings.map((s) => s.userId).filter((id) => joined.has(id));
        // You first, then everyone in rank order.
        order = [req.userId, ...order.filter((id) => id !== req.userId)];
      }
      const chosen = order.slice(0, EVENTS_PER_REQUEST);
      const usersById = await getUsers(ctx, chosen);
      const groups: EventGroup[] = [];
      for (let i = 0; i < chosen.length; i += 4) {
        const batch = await Promise.all(
          chosen.slice(i, i + 4).flatMap((id) => {
            const u = usersById.get(id);
            return u ? [eventGroupFor(ctx, ch, u, date, req.userId)] : [];
          }),
        );
        groups.push(...batch);
      }
      return { date, groups, more: Math.max(order.length - chosen.length, 0) };
    },
  );

  app.post<{ Params: { id: string } }>('/api/challenges/:id/respond', auth, async (req) => {
    const { accept, params: given, teamId: wantedTeam } = respondChallengeSchema.parse(req.body);
    const ch = await getChallenge(ctx, uuid(req.params.id));
    const parts = await assertCanView(ctx, ch, req.userId);
    const mine = parts.find((p) => p.userId === req.userId)!;
    if (challengeStatus(ctx, ch) === 'completed') throw badRequest('That challenge is over');
    const params = accept ? checkParams(ch.metric, given ?? paramsOf(mine)) : mine.params;
    const teamId =
      accept && ch.teamScoring
        ? chooseTeam({
            teams: await getTeams(ctx, ch.id),
            started: challengeStatus(ctx, ch) !== 'upcoming',
            mine,
            wanted: wantedTeam,
          })
        : mine.teamId;
    if (mine.state !== 'joined' || !accept || given || teamId !== mine.teamId) {
      await ctx.db
        .update(challengeParticipants)
        .set({ state: accept ? 'joined' : 'declined', params, teamId })
        .where(
          and(
            eq(challengeParticipants.challengeId, ch.id),
            eq(challengeParticipants.userId, req.userId),
          ),
        );
      if (accept) {
        await ctx.db
          .insert(feedEvents)
          .values({ actorId: req.userId, challengeId: ch.id, kind: 'joined', payload: {} });
        void syncUser(ctx, req.userId).catch(() => undefined);
      }
    }
    return loadDetail(ctx, ch.id, req.userId).catch(() => ({ ok: true }));
  });

  app.post<{ Params: { id: string } }>('/api/challenges/:id/invite', auth, async (req) => {
    const { userIds } = z
      .object({ userIds: z.array(z.string().uuid()).min(1).max(50) })
      .parse(req.body);
    const ch = await getChallenge(ctx, uuid(req.params.id));
    if (ch.solo) throw badRequest('A solo challenge is just for you.');
    const parts = await assertCanView(ctx, ch, req.userId);
    if (parts.find((p) => p.userId === req.userId)?.state !== 'joined')
      throw forbidden('Join the challenge first');
    if (challengeStatus(ctx, ch) === 'completed') throw badRequest('That challenge is over');
    const friends = new Set(await friendIds(ctx, req.userId));
    const fresh = userIds.filter((id) => friends.has(id) && !parts.some((p) => p.userId === id));
    if (fresh.length) {
      await ctx.db
        .insert(challengeParticipants)
        .values(
          fresh.map((userId) => ({
            challengeId: ch.id,
            userId,
            state: 'invited' as const,
            invitedBy: req.userId,
          })),
        )
        .onConflictDoNothing();
      await notifyChallengeInvites(ctx, ch, req.userId, fresh);
    }
    return loadDetail(ctx, ch.id, req.userId);
  });

  app.post<{ Params: { id: string } }>('/api/challenges/:id/leave', auth, async (req) => {
    const ch = await getChallenge(ctx, uuid(req.params.id));
    await assertCanView(ctx, ch, req.userId);
    await ctx.db
      .update(challengeParticipants)
      .set({ state: 'declined' })
      .where(
        and(
          eq(challengeParticipants.challengeId, ch.id),
          eq(challengeParticipants.userId, req.userId),
        ),
      );
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/challenges/:id', auth, async (req) => {
    const ch = await getChallenge(ctx, uuid(req.params.id));
    if (ch.createdBy !== req.userId) throw forbidden('Only the creator can delete a challenge');
    const others = (await getParticipants(ctx, ch.id)).filter(
      (p) => p.userId !== req.userId && p.state === 'joined',
    );
    if (challengeStatus(ctx, ch) !== 'upcoming' && others.length) {
      throw badRequest('Others have joined and it has started. Leave it instead.');
    }
    await ctx.db.delete(challenges).where(eq(challenges.id, ch.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/challenges/:id/rematch', auth, async (req, reply) => {
    const ch = await getChallenge(ctx, uuid(req.params.id));
    const parts = await assertCanView(ctx, ch, req.userId);
    if (challengeStatus(ctx, ch) !== 'completed')
      throw badRequest('Rematch is available once the challenge ends');
    const start = addDays(todayIn(ch.timezone, ctx.now()), 1);
    const end = addDays(start, daysBetween(ch.startDate, ch.endDate));
    const others = parts
      .filter((p) => p.state === 'joined' && p.userId !== req.userId)
      .map((p) => p.userId);
    const id = await ctx.db.transaction(async (tx) => {
      const [copy] = await tx
        .insert(challenges)
        .values({
          name: rematchName(ch.name),
          metric: ch.metric,
          customLabel: ch.customLabel,
          customUnit: ch.customUnit,
          aggregate: ch.aggregate,
          lowerIsBetter: ch.lowerIsBetter,
          scoring: ch.scoring,
          goal: ch.goal,
          startDate: start,
          endDate: end,
          timezone: ch.timezone,
          createdBy: req.userId,
          rematchOf: ch.id,
          visibility: ch.visibility,
          showEvents: ch.showEvents,
          solo: ch.solo,
          teamScoring: ch.teamScoring,
          // The side bet carries over, unsettled.
          stake: ch.stake,
        })
        .returning({ id: challenges.id });
      // Same teams, nobody on them yet; people are suggested the team they were on.
      const teamMap = ch.teamScoring
        ? await cloneTeams({ ...ctx, db: tx as unknown as AppContext['db'] }, ch.id, copy!.id)
        : new Map<string, string>();
      const mapTeam = (id: string | null | undefined) => (id ? (teamMap.get(id) ?? null) : null);
      const firstTeam = [...teamMap.values()][0] ?? null;
      await tx.insert(challengeParticipants).values([
        {
          challengeId: copy!.id,
          userId: req.userId,
          state: 'joined' as const,
          // Same target as last time; others pick theirs when they accept.
          params: parts.find((p) => p.userId === req.userId)?.params ?? null,
          teamId: ch.teamScoring
            ? (mapTeam(parts.find((p) => p.userId === req.userId)?.teamId) ?? firstTeam)
            : null,
        },
        ...others.map((userId) => ({
          challengeId: copy!.id,
          userId,
          state: 'invited' as const,
          invitedBy: req.userId,
          teamId: mapTeam(parts.find((p) => p.userId === userId)?.teamId),
        })),
      ]);
      if (!ch.solo)
        await tx.insert(feedEvents).values({
          actorId: req.userId,
          challengeId: copy!.id,
          kind: 'challenge_created',
          payload: { rematchOf: ch.id },
        });
      return copy!.id;
    });
    await notifyChallengeInvites(ctx, { id, name: ch.name, solo: ch.solo }, req.userId, others);
    reply.code(201);
    return loadDetail(ctx, id, req.userId);
  });

  app.get<{ Params: { id: string } }>(
    '/api/challenges/:id/result',
    auth,
    async (req): Promise<ChallengeResult> => {
      const detail = await loadDetail(ctx, uuid(req.params.id), req.userId);
      const ch = await getChallenge(ctx, detail.id);
      const parts = await getParticipants(ctx, ch.id);
      const { bestDays, standings } = await computeChallengeStandings(ctx, ch, parts);
      const mine = detail.standings.find((s) => s.isMe);
      // In a team challenge your place is your team's.
      const myTeam = detail.teams?.find((t) => t.memberIds.includes(req.userId));
      const winnerRow = detail.standings.find((s) => s.rank === 1 && s.score != null);
      const usersById = await getUsers(ctx, winnerRow ? [winnerRow.user.id] : []);
      const winner = winnerRow ? usersById.get(winnerRow.user.id) : undefined;
      return {
        challenge: detail,
        me: mine
          ? {
              rank: myTeam?.rank ?? mine.rank,
              score: mine.score,
              bestDay: bestDays.get(req.userId) ?? null,
              daysWithData: standings.find((s) => s.userId === req.userId)?.daysWithData ?? 0,
            }
          : null,
        winner: winner ? toPublicUser(winner) : null,
      };
    },
  );
}

/** Weight challenges need each person's own target; everything else takes no settings. */
function checkParams(
  metric: string,
  params: ParticipantParams | undefined,
): ParticipantParams | null {
  if (!needsWeightGoal(metric as MetricKey)) return null;
  if (!params?.weightGoal)
    throw badRequest(
      'Pick whether you want to lose or gain, and your target.',
      'needs_weight_goal',
    );
  return { weightGoal: params.weightGoal };
}

function uuid(id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Challenge not found');
  return id;
}
