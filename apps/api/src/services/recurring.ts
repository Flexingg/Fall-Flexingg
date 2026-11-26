/**
 * Recurring challenges on the server: starting the next round when one is finalized, and working
 * out a series' page info (round number, earlier rounds, the season table of wins and podiums).
 * Deliberately doesn't import services/challenges.ts, which calls into this file.
 */
import {
  nextRoundDates,
  recurrenceSchema,
  todayIn,
  type SeasonRow,
  type SeriesInfo,
} from '@gauntlet/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { challengeParticipants, challenges, challengeTeams, feedEvents } from '../db/schema.js';
import { notify } from './notify.js';
import { getUsers, toPublicUser } from './users.js';

type ChallengeRow = typeof challenges.$inferSelect;
type ParticipantRow = typeof challengeParticipants.$inferSelect;

export interface NextRound {
  id: string;
  round: number;
  startDate: string;
  /** People invited to the new round (they still have to accept). */
  invitees: string[];
}

/**
 * Create the round after `prev`, inside the transaction that finalizes it. Same settings, a fresh
 * empty set of teams, the creator joined automatically and (with carry-over) everyone who joined
 * the last round invited. Does nothing when the series is over: repeating was turned off, the max
 * number of rounds is reached, or the next round already exists (so it can never be created twice).
 */
export async function createNextRound(
  ctx: AppContext,
  prev: ChallengeRow,
  prevParts: ParticipantRow[],
): Promise<NextRound | null> {
  const parsed = recurrenceSchema.safeParse(prev.recurrence);
  if (!parsed.success || prev.solo) return null;
  const rec = parsed.data;
  const round = prev.seriesRound ?? 1;
  if (rec.maxRounds != null && round >= rec.maxRounds) return null;
  const seriesId = prev.seriesId ?? prev.id;

  await ctx.db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`series:${seriesId}`}, 0))`,
  );
  const [existing] = await ctx.db
    .select({ id: challenges.id })
    .from(challenges)
    .where(and(eq(challenges.seriesId, seriesId), eq(challenges.seriesRound, round + 1)));
  if (existing) return null;
  if (!prev.seriesId)
    await ctx.db
      .update(challenges)
      .set({ seriesId, seriesRound: round })
      .where(eq(challenges.id, prev.id));

  const { start, end } = nextRoundDates(prev.startDate, prev.endDate);
  const [next] = await ctx.db
    .insert(challenges)
    .values({
      name: prev.name,
      metric: prev.metric,
      customLabel: prev.customLabel,
      customUnit: prev.customUnit,
      aggregate: prev.aggregate,
      lowerIsBetter: prev.lowerIsBetter,
      scoring: prev.scoring,
      goal: prev.goal,
      startDate: start,
      endDate: end,
      timezone: prev.timezone,
      createdBy: prev.createdBy,
      visibility: prev.visibility,
      showEvents: prev.showEvents,
      maxParticipants: prev.maxParticipants,
      teamScoring: prev.teamScoring,
      recurrence: rec,
      seriesId,
      seriesRound: round + 1,
    })
    .returning({ id: challenges.id });

  // Teams: the same definitions, nobody on them yet (people may be suggested their old team).
  const teamMap = new Map<string, string>();
  let firstTeam: string | null = null;
  if (prev.teamScoring) {
    const old = await ctx.db
      .select()
      .from(challengeTeams)
      .where(eq(challengeTeams.challengeId, prev.id))
      .orderBy(asc(challengeTeams.position));
    const fresh = await ctx.db
      .insert(challengeTeams)
      .values(
        old.map((t, position) => ({
          challengeId: next!.id,
          name: t.name,
          color: t.color,
          position,
        })),
      )
      .returning();
    old.forEach((t, i) => teamMap.set(t.id, fresh[i]!.id));
    firstTeam = fresh[0]?.id ?? null;
  }
  const mapTeam = (id: string | null) => (id ? (teamMap.get(id) ?? null) : null);

  const creatorPrev = prevParts.find((p) => p.userId === prev.createdBy);
  const invitees = rec.carryOver
    ? prevParts.filter((p) => p.state === 'joined' && p.userId !== prev.createdBy)
    : [];
  await ctx.db.insert(challengeParticipants).values([
    {
      challengeId: next!.id,
      userId: prev.createdBy,
      state: 'joined' as const,
      params: creatorPrev?.params ?? null,
      teamId: prev.teamScoring ? (mapTeam(creatorPrev?.teamId ?? null) ?? firstTeam) : null,
    },
    ...invitees.map((p) => ({
      challengeId: next!.id,
      userId: p.userId,
      state: 'invited' as const,
      invitedBy: prev.createdBy,
      // Their settings and team from last time are suggestions; accepting confirms them.
      params: p.params,
      teamId: mapTeam(p.teamId),
    })),
  ]);
  await ctx.db.insert(feedEvents).values({
    actorId: prev.createdBy,
    challengeId: next!.id,
    kind: 'challenge_created',
    payload: { round: round + 1 },
  });
  return {
    id: next!.id,
    round: round + 1,
    startDate: start,
    invitees: invitees.map((p) => p.userId),
  };
}

/** Tell the people invited to a new round (call after the transaction has committed). */
export async function notifyNewRound(
  ctx: AppContext,
  ch: { id: string; name: string; timezone: string },
  next: NextRound,
): Promise<void> {
  const today = todayIn(ch.timezone, ctx.now());
  const when =
    next.startDate <= today
      ? 'starts today'
      : `starts ${new Date(`${next.startDate}T00:00:00Z`).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        })}`;
  for (const userId of next.invitees) {
    await notify(ctx, userId, {
      kind: 'new_round',
      title: `Round ${next.round} of ${ch.name}`,
      body: `Round ${next.round} of ${ch.name} ${when}. Tap to join.`,
      url: `/c/${next.id}`,
      payload: { challengeId: next.id, round: next.round },
    });
  }
}

/**
 * A series' round number, the earlier rounds the viewer can open, and the season table: wins
 * (first place) and podiums (top three, wins included) per person across the finished rounds the
 * viewer can see. Null for a challenge that isn't part of a series.
 */
export async function loadSeriesInfo(
  ctx: AppContext,
  ch: ChallengeRow,
  viewerId: string,
): Promise<SeriesInfo | null> {
  if (!ch.seriesId) return null;
  const rounds = await ctx.db
    .select()
    .from(challenges)
    .where(eq(challenges.seriesId, ch.seriesId))
    .orderBy(asc(challenges.seriesRound));
  const parts = await ctx.db
    .select()
    .from(challengeParticipants)
    .where(
      inArray(
        challengeParticipants.challengeId,
        rounds.map((r) => r.id),
      ),
    );
  const visible = rounds.filter(
    (r) =>
      r.id === ch.id ||
      r.visibility === 'public' ||
      parts.some((p) => p.challengeId === r.id && p.userId === viewerId),
  );
  const round = ch.seriesRound ?? 1;
  const link = (r: ChallengeRow) => ({
    id: r.id,
    round: r.seriesRound ?? 1,
    startDate: r.startDate,
    endDate: r.endDate,
  });

  const tally = new Map<string, { wins: number; podiums: number; rounds: number }>();
  for (const r of visible.filter((x) => x.finalizedAt)) {
    for (const p of parts) {
      if (p.challengeId !== r.id || p.state !== 'joined' || p.finalRank == null) continue;
      const t = tally.get(p.userId) ?? { wins: 0, podiums: 0, rounds: 0 };
      t.rounds++;
      if (p.finalRank === 1) t.wins++;
      if (p.finalRank <= 3) t.podiums++;
      tally.set(p.userId, t);
    }
  }
  const usersById = await getUsers(ctx, [...tally.keys()]);
  const season: SeasonRow[] = [...tally]
    .flatMap(([userId, t]) => {
      const u = usersById.get(userId);
      return u ? [{ user: toPublicUser(u), ...t }] : [];
    })
    .sort(
      (a, b) =>
        b.wins - a.wins ||
        b.podiums - a.podiums ||
        a.rounds - b.rounds ||
        a.user.displayName.localeCompare(b.user.displayName),
    );
  const next = visible.find((r) => (r.seriesRound ?? 1) === round + 1);
  return {
    round,
    previous: visible.filter((r) => (r.seriesRound ?? 1) < round).map(link),
    next: next ? link(next) : null,
    season,
  };
}
