import {
  addDays,
  computeStandings,
  daysBetween,
  participantParamsSchema,
  soloProgress,
  type SoloProgress,
  relativeSeries,
  weightGoalSeries,
  type MetricTransform,
  type ScoringRules,
  type ParticipantParams,
  maxDate,
  metricDef,
  minDate,
  todayIn,
  type ChallengeDetail,
  type ChallengeStatus,
  type ChallengeSummary,
  type MetricDef,
  type MetricKey,
  type ParticipantState,
  type SeriesInfo,
  type Standing,
  type StandingRow,
  ordinal,
  recurrenceSchema,
} from '@gauntlet/shared';
import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { forbidden, notFound } from '../context.js';
import {
  challengeParticipants,
  challenges,
  dailyMetrics,
  feedEvents,
  rankSnapshots,
} from '../db/schema.js';
import { notify } from './notify.js';
import { createNextRound, loadSeriesInfo, notifyNewRound, type NextRound } from './recurring.js';
import { buildTeams, getTeams, getTeamsFor, type TeamRow } from './teams.js';
import { notifyLeadChange } from './notifyEvents.js';
import { getUsers, toPublicUser, type UserRow } from './users.js';

export type ChallengeRow = typeof challenges.$inferSelect;
export type ParticipantRow = typeof challengeParticipants.$inferSelect;

export function challengeMetricDef(ch: ChallengeRow): MetricDef {
  const def = metricDef(ch.metric as MetricKey, {
    label: ch.customLabel ?? ch.metric,
    unit: ch.customUnit ?? undefined,
    aggregate: ch.aggregate,
    lowerIsBetter: ch.lowerIsBetter,
  });
  return { ...def, aggregate: ch.aggregate, lowerIsBetter: ch.lowerIsBetter };
}

export function challengeToday(ctx: AppContext, ch: Pick<ChallengeRow, 'timezone'>): string {
  return todayIn(ch.timezone, ctx.now());
}

export function challengeStatus(ctx: AppContext, ch: ChallengeRow): ChallengeStatus {
  if (ch.finalizedAt) return 'completed';
  const today = challengeToday(ctx, ch);
  if (today < ch.startDate) return 'upcoming';
  if (today > ch.endDate) return 'completed';
  return 'active';
}

export async function getChallenge(ctx: AppContext, id: string): Promise<ChallengeRow> {
  const [ch] = await ctx.db.select().from(challenges).where(eq(challenges.id, id));
  if (!ch) throw notFound('Challenge not found');
  return ch;
}

export async function getParticipants(
  ctx: AppContext,
  challengeId: string,
): Promise<ParticipantRow[]> {
  return ctx.db
    .select()
    .from(challengeParticipants)
    .where(eq(challengeParticipants.challengeId, challengeId));
}

/**
 * Throws unless the viewer was invited to or joined the challenge, or (with
 * `allowPublic`) the challenge is public.
 */
export async function assertCanView(
  ctx: AppContext,
  ch: ChallengeRow,
  userId: string,
  opts: { allowPublic?: boolean } = {},
): Promise<ParticipantRow[]> {
  const parts = await getParticipants(ctx, ch.id);
  if (opts.allowPublic && ch.visibility === 'public') return parts;
  if (!parts.some((p) => p.userId === userId))
    throw forbidden('You are not part of this challenge');
  return parts;
}

export interface ComputedStandings {
  asOf: string;
  standings: Standing[];
  bestDays: Map<string, number>;
  /** Each joined person's daily values (after any per-person transform). */
  byUser: Map<string, { date: string; value: number }[]>;
}

/** Each joined person's daily values for a challenge, after any per-person transform. */
export async function loadSeries(
  ctx: AppContext,
  ch: ChallengeRow,
  parts: ParticipantRow[],
): Promise<{ joined: string[]; byUser: Map<string, { date: string; value: number }[]> }> {
  const joined = parts.filter((p) => p.state === 'joined').map((p) => p.userId);
  const def = challengeMetricDef(ch);
  // Per-person transforms need each person's values from before the start, as their baseline.
  const from = def.transform ? addDays(ch.startDate, -BASELINE_DAYS) : ch.startDate;
  const raw = joined.length
    ? await ctx.db
        .select({ userId: dailyMetrics.userId, date: dailyMetrics.date, value: dailyMetrics.value })
        .from(dailyMetrics)
        .where(
          and(
            inArray(dailyMetrics.userId, joined),
            eq(dailyMetrics.metric, def.source ?? ch.metric),
            gte(dailyMetrics.date, from),
            lte(dailyMetrics.date, ch.endDate),
          ),
        )
    : [];
  const rows = def.transform ? transformRows(def.transform, raw, parts, ch.startDate) : raw;
  const byUser = new Map<string, { date: string; value: number }[]>(joined.map((id) => [id, []]));
  for (const r of rows) byUser.get(r.userId)?.push({ date: r.date, value: r.value });
  return { joined, byUser };
}

export function scoringRules(ctx: AppContext, ch: ChallengeRow): ScoringRules {
  return {
    scoring: ch.scoring,
    aggregate: ch.aggregate,
    lowerIsBetter: ch.lowerIsBetter,
    goal: ch.goal,
    startDate: ch.startDate,
    endDate: ch.endDate,
    asOf: minDate(maxDate(challengeToday(ctx, ch), ch.startDate), ch.endDate),
  };
}

export async function computeChallengeStandings(
  ctx: AppContext,
  ch: ChallengeRow,
  parts: ParticipantRow[],
): Promise<ComputedStandings> {
  const rules = scoringRules(ctx, ch);
  const { byUser } = await loadSeries(ctx, ch, parts);
  const bestDays = new Map<string, number>();
  for (const [userId, days] of byUser) {
    for (const r of days) {
      if (r.date > rules.asOf) continue;
      const prev = bestDays.get(userId);
      const better = ch.lowerIsBetter
        ? prev == null || r.value < prev
        : prev == null || r.value > prev;
      if (better) bestDays.set(userId, r.value);
    }
  }
  const standings = computeStandings(
    rules,
    [...byUser].map(([userId, days]) => ({ userId, days })),
  );
  return { asOf: rules.asOf, standings, bestDays, byUser };
}

/** How a solo challenge is going, for its one participant. Null for a challenge with friends. */
export async function soloFor(
  ctx: AppContext,
  ch: ChallengeRow,
  byUser: Map<string, { date: string; value: number }[]>,
): Promise<SoloProgress | null> {
  const solo = ch.solo;
  if (!solo) return null;
  const rules = scoringRules(ctx, ch);
  const def = challengeMetricDef(ch);
  let baselineDays: { date: string; value: number }[] = [];
  if (solo.kind === 'improve') {
    baselineDays = await ctx.db
      .select({ date: dailyMetrics.date, value: dailyMetrics.value })
      .from(dailyMetrics)
      .where(
        and(
          eq(dailyMetrics.userId, ch.createdBy),
          eq(dailyMetrics.metric, def.source ?? ch.metric),
          gte(dailyMetrics.date, addDays(ch.startDate, -solo.baselineDays)),
          lte(dailyMetrics.date, addDays(ch.startDate, -1)),
        ),
      );
  }
  return soloProgress({
    solo,
    rules,
    days: byUser.get(ch.createdBy) ?? [],
    baselineDays,
    today: challengeToday(ctx, ch),
  });
}

/** How far back to look for someone's starting weight or starting 1RM. */
const BASELINE_DAYS = 90;

/** Turn stored values into what each person is scored on (their own target or starting point). */
function transformRows(
  transform: MetricTransform,
  raw: { userId: string; date: string; value: number }[],
  parts: ParticipantRow[],
  startDate: string,
): { userId: string; date: string; value: number }[] {
  const byUser = new Map<string, { date: string; value: number }[]>();
  for (const r of raw) {
    const list = byUser.get(r.userId) ?? [];
    list.push({ date: r.date, value: r.value });
    byUser.set(r.userId, list);
  }
  const out: { userId: string; date: string; value: number }[] = [];
  for (const [userId, series] of byUser) {
    let values: { date: string; value: number }[] = [];
    if (transform === 'relative') values = relativeSeries(series, startDate);
    else {
      const params = paramsOf(parts.find((p) => p.userId === userId));
      if (params.weightGoal) values = weightGoalSeries(series, params.weightGoal, startDate);
    }
    for (const v of values) out.push({ userId, ...v });
  }
  return out;
}

export function paramsOf(p: Pick<ParticipantRow, 'params'> | undefined): ParticipantParams {
  const parsed = participantParamsSchema.safeParse(p?.params ?? {});
  return parsed.success ? parsed.data : {};
}

interface BuildArgs {
  ctx: AppContext;
  ch: ChallengeRow;
  parts: ParticipantRow[];
  viewerId: string;
  computed: ComputedStandings;
  usersById: Map<string, UserRow>;
  /** Set for a solo challenge. */
  solo?: SoloProgress | null;
  /** This challenge's teams (team challenges only). */
  teamRows?: TeamRow[];
  /** Round and season info (recurring series only). */
  series?: SeriesInfo | null;
}

/** The team leaderboard, from each person's score (their final score once the challenge is over). */
function teamsFor(
  ch: ChallengeRow,
  teamRows: TeamRow[] | undefined,
  parts: ParticipantRow[],
  computed: ComputedStandings,
) {
  if (!ch.teamScoring || !teamRows?.length) return null;
  const finalized = !!ch.finalizedAt;
  const partByUser = new Map(parts.map((p) => [p.userId, p]));
  const scoreOf = new Map(
    computed.standings.map((s) => {
      const p = partByUser.get(s.userId);
      return [s.userId, finalized && p?.finalScore != null ? p.finalScore : s.score] as const;
    }),
  );
  // After the end, a team's rank is the one every member was given, so it can't drift.
  const finalRanks = new Map<string, number>();
  if (finalized)
    for (const p of parts)
      if (p.teamId && p.finalRank != null && p.state === 'joined')
        finalRanks.set(p.teamId, p.finalRank);
  return buildTeams({
    teams: teamRows,
    mode: ch.teamScoring,
    scoring: ch.scoring,
    lowerIsBetter: ch.lowerIsBetter,
    parts,
    scoreOf,
    finalRanks,
  });
}

export function buildSummary({
  ctx,
  ch,
  parts,
  viewerId,
  computed,
  usersById,
  solo = null,
  teamRows,
}: BuildArgs): ChallengeSummary {
  const def = challengeMetricDef(ch);
  const status = challengeStatus(ctx, ch);
  const me = parts.find((p) => p.userId === viewerId);
  const finalized = !!ch.finalizedAt;
  const standingFor = (userId: string) => computed.standings.find((s) => s.userId === userId);
  const mine = standingFor(viewerId);
  // In a team challenge your place is your team's.
  const teamList = teamsFor(ch, teamRows, parts, computed);
  const myTeam = teamList?.find((t) => me?.state === 'joined' && t.memberIds.includes(viewerId));
  const myRank = myTeam
    ? myTeam.rank
    : finalized
      ? (me?.finalRank ?? mine?.rank ?? null)
      : (mine?.rank ?? null);
  let myScore = finalized ? (me?.finalScore ?? mine?.score ?? null) : (mine?.score ?? null);
  // Against yourself the headline number is the thing being aimed at: % change or streak length.
  if (solo && (solo.kind === 'improve' || solo.kind === 'streak')) myScore = solo.current;

  const leaderStanding = computed.standings[0];
  const leaderUser = leaderStanding ? usersById.get(leaderStanding.userId) : undefined;
  let gap: ChallengeSummary['gap'] = null;
  if (mine && mine.score != null) {
    const idx = computed.standings.indexOf(mine);
    const ahead = computed.standings
      .slice(0, idx)
      .reverse()
      .find((s) => s.score != null && s.rank < mine.rank);
    const behind = computed.standings[idx + 1];
    const other = ahead ?? (behind && behind.score != null ? behind : undefined);
    const otherUser = other ? usersById.get(other.userId) : undefined;
    if (other && otherUser && other.score != null) {
      gap = {
        user: toPublicUser(otherUser),
        amount: Math.abs(other.score - mine.score),
        ahead: !!ahead,
      };
    }
  }

  const today = challengeToday(ctx, ch);
  return {
    id: ch.id,
    name: ch.name,
    metric: ch.metric as MetricKey,
    metricLabel: solo
      ? `${def.label} ${{ target: 'total', average: 'per day', streak: 'streak', improve: 'vs before' }[solo.kind]}`
      : def.label,
    unit: solo?.valueKind === 'pct' ? '%' : solo?.valueKind === 'days' ? 'days' : def.unit,
    decimals: solo?.valueKind === 'pct' ? 1 : solo?.valueKind === 'days' ? 0 : def.decimals,
    scoring: ch.scoring,
    goal: ch.goal,
    startDate: ch.startDate,
    endDate: ch.endDate,
    timezone: ch.timezone,
    status,
    participantCount: parts.filter((p) => p.state === 'joined').length,
    myState: (me?.state as ParticipantState | undefined) ?? null,
    myRank,
    myScore,
    leader:
      leaderUser && leaderStanding?.score != null
        ? { user: toPublicUser(leaderUser), score: leaderStanding.score }
        : null,
    gap,
    daysLeft:
      status === 'completed'
        ? 0
        : Math.max(daysBetween(maxDate(today, ch.startDate), ch.endDate) + 1, 0),
    createdBy: ch.createdBy,
    visibility: ch.visibility,
    featured: ch.featured,
    showEvents: ch.showEvents,
    solo,
    recurrence: recurrenceSchema.safeParse(ch.recurrence).data ?? null,
    seriesRound: ch.seriesRound,
    teamScoring: ch.teamScoring,
  };
}

export function buildDetail(args: BuildArgs): ChallengeDetail {
  const { ch, parts, viewerId, computed, usersById } = args;
  const summary = buildSummary(args);
  const finalized = !!ch.finalizedAt;
  const partByUser = new Map(parts.map((p) => [p.userId, p]));
  const standings: StandingRow[] = computed.standings.flatMap((s) => {
    const u = usersById.get(s.userId);
    const p = partByUser.get(s.userId);
    if (!u || !p) return [];
    return [
      {
        user: toPublicUser(u),
        // A team challenge's final rank is the team's, so people keep their own rank here.
        rank: finalized && p.finalRank != null && !ch.teamScoring ? p.finalRank : s.rank,
        score: finalized && p.finalScore != null ? p.finalScore : s.score,
        progress: s.progress,
        reachedGoalOn: s.reachedGoalOn,
        todayValue: s.todayValue,
        state: p.state,
        lastSyncedAt: u.lastSyncedAt?.toISOString() ?? null,
        isMe: s.userId === viewerId,
        teamId: p.teamId,
      },
    ];
  });
  if (finalized && !ch.teamScoring) standings.sort((a, b) => a.rank - b.rank);
  const invited = parts
    .filter((p) => p.state === 'invited')
    .map((p) => usersById.get(p.userId))
    .filter((u): u is UserRow => !!u)
    .map(toPublicUser);
  const mine = partByUser.get(viewerId);
  return {
    ...summary,
    soloConfig: ch.solo ?? null,
    myParams: mine ? paramsOf(mine) : null,
    lowerIsBetter: ch.lowerIsBetter,
    aggregate: ch.aggregate,
    standings,
    invited,
    rematchOf: ch.rematchOf,
    teams: teamsFor(ch, args.teamRows, parts, computed),
    myTeamId: mine?.teamId ?? null,
    series: args.series ?? null,
  };
}

/** Load everything needed to render one challenge for a viewer. */
export async function loadDetail(
  ctx: AppContext,
  challengeId: string,
  viewerId: string,
): Promise<ChallengeDetail> {
  const ch = await getChallenge(ctx, challengeId);
  const parts = await assertCanView(ctx, ch, viewerId, { allowPublic: true });
  const computed = await computeChallengeStandings(ctx, ch, parts);
  const usersById = await getUsers(
    ctx,
    parts.map((p) => p.userId),
  );
  const solo = await soloFor(ctx, ch, computed.byUser);
  const teamRows = ch.teamScoring ? await getTeams(ctx, ch.id) : [];
  const series = await loadSeriesInfo(ctx, ch, viewerId);
  return buildDetail({ ctx, ch, parts, viewerId, computed, usersById, solo, teamRows, series });
}

export async function listForUser(ctx: AppContext, userId: string): Promise<ChallengeSummary[]> {
  const mine = await ctx.db
    .select({ challengeId: challengeParticipants.challengeId })
    .from(challengeParticipants)
    .where(
      and(
        eq(challengeParticipants.userId, userId),
        inArray(challengeParticipants.state, ['invited', 'joined']),
      ),
    );
  if (!mine.length) return [];
  const ids = mine.map((m) => m.challengeId);
  const chs = await ctx.db.select().from(challenges).where(inArray(challenges.id, ids));
  const out = await summarize(ctx, chs, userId);
  const order: Record<ChallengeStatus, number> = { active: 0, upcoming: 1, completed: 2 };
  return out.sort(
    (a, b) =>
      order[a.status] - order[b.status] ||
      (a.status === 'completed'
        ? b.endDate.localeCompare(a.endDate)
        : a.endDate.localeCompare(b.endDate)),
  );
}

/** Summaries of the given challenges as one viewer sees them. */
export async function summarize(
  ctx: AppContext,
  chs: ChallengeRow[],
  userId: string,
): Promise<ChallengeSummary[]> {
  if (!chs.length) return [];
  const ids = chs.map((c) => c.id);
  const allParts = await ctx.db
    .select()
    .from(challengeParticipants)
    .where(inArray(challengeParticipants.challengeId, ids));
  const usersById = await getUsers(
    ctx,
    allParts.map((p) => p.userId),
  );
  const out: ChallengeSummary[] = [];
  const allTeams = await getTeamsFor(
    ctx,
    chs.filter((c) => c.teamScoring).map((c) => c.id),
  );
  for (const ch of chs) {
    const parts = allParts.filter((p) => p.challengeId === ch.id);
    const computed = await computeChallengeStandings(ctx, ch, parts);
    const solo = await soloFor(ctx, ch, computed.byUser);
    const teamRows = allTeams.filter((t) => t.challengeId === ch.id);
    out.push(
      buildSummary({ ctx, ch, parts, viewerId: userId, computed, usersById, solo, teamRows }),
    );
  }
  return out;
}

/** Challenges a user has joined that are still running (or about to). */
export async function openChallengesForUser(
  ctx: AppContext,
  userId: string,
): Promise<ChallengeRow[]> {
  const rows = await ctx.db
    .select({ ch: challenges })
    .from(challengeParticipants)
    .innerJoin(challenges, eq(challenges.id, challengeParticipants.challengeId))
    .where(
      and(
        eq(challengeParticipants.userId, userId),
        eq(challengeParticipants.state, 'joined'),
        isNull(challenges.finalizedAt),
      ),
    );
  return rows.map((r) => r.ch);
}

/**
 * Recompute a challenge after new data: record today's ranks for the rank
 * history chart and announce a new leader.
 *
 * Several people's syncs can finish at the same moment, so this runs under a
 * per-challenge lock and works from the database, never from a challenge row
 * loaded earlier: a stale row would carry an out-of-date leader.
 */
export async function refreshChallenge(ctx: AppContext, challengeId: string): Promise<void> {
  // Who just lost the lead; told once the transaction (and its lock) is done.
  let overtaken: { name: string; newLeaderId: string; previousLeaderId: string } | null = null;
  await ctx.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`challenge:${challengeId}`}, 0))`,
    );
    const txCtx: AppContext = { ...ctx, db: tx as unknown as AppContext['db'] };
    const [ch] = await tx.select().from(challenges).where(eq(challenges.id, challengeId));
    if (!ch || challengeStatus(txCtx, ch) !== 'active') return;

    const parts = await getParticipants(txCtx, ch.id);
    const { standings, asOf } = await computeChallengeStandings(txCtx, ch, parts);
    const ranked = standings.filter((s) => s.score != null);
    if (ranked.length) {
      await tx
        .insert(rankSnapshots)
        .values(
          ranked.map((s) => ({ challengeId: ch.id, userId: s.userId, date: asOf, rank: s.rank })),
        )
        .onConflictDoUpdate({
          target: [rankSnapshots.challengeId, rankSnapshots.userId, rankSnapshots.date],
          set: { rank: sqlExcluded('rank') },
        });
    }

    const top = ranked[0];
    const soleLeader =
      top &&
      top.rank === 1 &&
      ranked.filter((s) => s.rank === 1).length === 1 &&
      (top.score ?? 0) > 0;
    if (!soleLeader || top.userId === ch.leaderId) return;

    await tx.update(challenges).set({ leaderId: top.userId }).where(eq(challenges.id, ch.id));
    // The first leader is not an overtake.
    if (ch.leaderId && ranked.length > 1) {
      await tx.insert(feedEvents).values({
        actorId: top.userId,
        challengeId: ch.id,
        kind: 'took_lead',
        payload: { previousLeaderId: ch.leaderId },
      });
      overtaken = { name: ch.name, newLeaderId: top.userId, previousLeaderId: ch.leaderId };
    }
  });
  if (overtaken) {
    const o = overtaken as { name: string; newLeaderId: string; previousLeaderId: string };
    await notifyLeadChange(ctx, { id: challengeId, name: o.name }, o.newLeaderId, [
      o.previousLeaderId,
    ]).catch((err) => ctx.log.warn({ err: String(err) }, 'lead change notification failed'));
  }
}

/**
 * Close challenges whose last day has passed: freeze ranks, announce the winner(s), tell everyone
 * and, for a recurring challenge, start the next round (all in one transaction, so a finished
 * round never lacks its successor and never gets two).
 *
 * In a team challenge each member's final rank is their team's rank (so trophies credit team
 * podiums) while their final score stays their own.
 */
export async function finalizeChallenge(ctx: AppContext, ch: ChallengeRow): Promise<boolean> {
  if (ch.finalizedAt || challengeToday(ctx, ch) <= ch.endDate) return false;
  const parts = await getParticipants(ctx, ch.id);
  const { standings } = await computeChallengeStandings(ctx, ch, parts);
  const teamRows = ch.teamScoring ? await getTeams(ctx, ch.id) : [];
  const teamList = teamsFor(ch, teamRows, parts, {
    standings,
    asOf: '',
    bestDays: new Map(),
    byUser: new Map(),
  });
  const teamOf = (userId: string) => teamList?.find((t) => t.memberIds.includes(userId)) ?? null;
  const result = await ctx.db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(challenges)
      .set({ finalizedAt: ctx.now() })
      .where(and(eq(challenges.id, ch.id), isNull(challenges.finalizedAt)))
      .returning({ id: challenges.id });
    if (!claimed) return null;
    for (const s of standings) {
      await tx
        .update(challengeParticipants)
        .set({ finalRank: teamOf(s.userId)?.rank ?? s.rank, finalScore: s.score })
        .where(
          and(
            eq(challengeParticipants.challengeId, ch.id),
            eq(challengeParticipants.userId, s.userId),
          ),
        );
    }
    if (!ch.solo) {
      const winners = teamList
        ? standings.filter((s) => {
            const t = teamOf(s.userId);
            return t && t.rank === 1 && t.score != null;
          })
        : standings.filter((s) => s.rank === 1 && s.score != null);
      for (const w of winners) {
        const team = teamOf(w.userId);
        await tx.insert(feedEvents).values({
          actorId: w.userId,
          challengeId: ch.id,
          kind: 'challenge_won',
          payload: team
            ? { score: w.score, teamName: team.name, teamId: team.id }
            : { score: w.score },
        });
      }
    }
    const next = ch.recurrence
      ? await createNextRound({ ...ctx, db: tx as unknown as AppContext['db'] }, ch, parts)
      : null;
    return { next };
  });
  if (!result) return false;
  // The single place results are announced, once, by whoever closed the challenge (team-aware).
  if (!ch.solo)
    await announceFinish(ctx, ch, standings, teamList).catch((err) =>
      ctx.log.warn({ err: String(err) }, 'challenge result notification failed'),
    );
  if (result.next) await notifyNewRound(ctx, ch, result.next satisfies NextRound);
  return true;
}

/** Tell everyone in a finished challenge how it went. */
async function announceFinish(
  ctx: AppContext,
  ch: ChallengeRow,
  standings: Standing[],
  teamList: ReturnType<typeof teamsFor>,
) {
  const winningTeams = teamList?.filter((t) => t.rank === 1 && t.score != null) ?? [];
  const n = teamList?.length ?? standings.length;
  for (const s of standings) {
    const team = teamList?.find((t) => t.memberIds.includes(s.userId));
    const rank = team?.rank ?? s.rank;
    const hasScore = team ? team.score != null : s.score != null;
    let body: string;
    if (!hasScore) body = 'The challenge has ended.';
    else if (team)
      body =
        rank === 1
          ? `${team.name} won! Great teamwork.`
          : `${team.name} finished ${ordinal(rank)} of ${n}${
              winningTeams.length ? `. ${winningTeams.map((t) => t.name).join(' and ')} won` : ''
            }.`;
    else body = rank === 1 ? 'You won!' : `You finished ${ordinal(rank)} of ${n}.`;
    await notify(ctx, s.userId, {
      kind: 'challenge_finished',
      title: `${ch.name} is over`,
      body,
      url: `/c/${ch.id}/result`,
      payload: { challengeId: ch.id, rank: hasScore ? rank : null },
    });
  }
}

function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}
