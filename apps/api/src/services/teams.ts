/**
 * Team challenges on the server: loading and creating a challenge's teams, deciding which team a
 * person lands on when they join, and building the team leaderboard shown with the standings.
 * The maths itself (sum/average, ranking, shuffling) is shared with the web app.
 */
import { computeTeamScores, type ChallengeTeam, type TeamScoring } from '@gauntlet/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { badRequest } from '../context.js';
import { challengeTeams } from '../db/schema.js';

export type TeamRow = typeof challengeTeams.$inferSelect;

export async function getTeams(ctx: AppContext, challengeId: string): Promise<TeamRow[]> {
  return ctx.db
    .select()
    .from(challengeTeams)
    .where(eq(challengeTeams.challengeId, challengeId))
    .orderBy(asc(challengeTeams.position));
}

export async function getTeamsFor(ctx: AppContext, challengeIds: string[]): Promise<TeamRow[]> {
  if (!challengeIds.length) return [];
  return ctx.db
    .select()
    .from(challengeTeams)
    .where(inArray(challengeTeams.challengeId, challengeIds))
    .orderBy(asc(challengeTeams.position));
}

export async function insertTeams(
  ctx: AppContext,
  challengeId: string,
  defs: { name: string; color: string }[],
): Promise<TeamRow[]> {
  return ctx.db
    .insert(challengeTeams)
    .values(defs.map((d, position) => ({ challengeId, name: d.name, color: d.color, position })))
    .returning();
}

/** Copy one challenge's team definitions (not its members). Returns old team id -> new team id. */
export async function cloneTeams(
  ctx: AppContext,
  fromChallengeId: string,
  toChallengeId: string,
): Promise<Map<string, string>> {
  const old = await getTeams(ctx, fromChallengeId);
  const fresh = await insertTeams(ctx, toChallengeId, old);
  return new Map(old.map((t, i) => [t.id, fresh[i]!.id]));
}

/**
 * Which team someone ends up on when they join or accept. Team challenges need a valid pick (an
 * invitee may have a suggested team already, e.g. their team last round). Once the challenge has
 * started, someone already on a team can't switch.
 */
export function chooseTeam(args: {
  teams: TeamRow[];
  started: boolean;
  mine: { state: string; teamId: string | null } | undefined;
  wanted: string | undefined;
}): string {
  const { teams, started, mine, wanted } = args;
  const current = mine?.teamId ?? null;
  const pick = wanted ?? current;
  if (!pick || !teams.some((t) => t.id === pick))
    throw badRequest('Pick a team to join.', 'needs_team');
  const wasOn = mine && (mine.state === 'joined' || mine.state === 'declined') && current;
  if (started && wasOn && pick !== current)
    throw badRequest('Teams are locked once the challenge starts.', 'teams_locked');
  return pick;
}

/**
 * The team leaderboard. `scoreOf` is each joined person's score (final once the challenge is
 * over). `finalRanks` (team id -> rank) freezes the order after the challenge ends.
 */
export function buildTeams(args: {
  teams: TeamRow[];
  mode: TeamScoring;
  scoring: Parameters<typeof computeTeamScores>[0]['scoring'];
  lowerIsBetter: boolean;
  parts: { userId: string; state: string; teamId: string | null }[];
  scoreOf: Map<string, number | null>;
  finalRanks?: Map<string, number>;
}): ChallengeTeam[] {
  const { teams, parts, scoreOf, finalRanks } = args;
  const members = (teamId: string) =>
    parts.filter((p) => p.state === 'joined' && p.teamId === teamId).map((p) => p.userId);
  const scores = computeTeamScores(
    { mode: args.mode, scoring: args.scoring, lowerIsBetter: args.lowerIsBetter },
    teams.map((t) => ({
      id: t.id,
      memberScores: members(t.id).map((id) => scoreOf.get(id) ?? null),
    })),
  );
  return teams
    .map((t, position) => {
      const r = scores.find((s) => s.teamId === t.id)!;
      return {
        position,
        team: {
          id: t.id,
          name: t.name,
          color: t.color,
          score: r.score,
          rank: finalRanks?.get(t.id) ?? r.rank,
          memberIds: members(t.id),
        } satisfies ChallengeTeam,
      };
    })
    .sort((a, b) => a.team.rank - b.team.rank || a.position - b.position)
    .map((x) => x.team);
}
