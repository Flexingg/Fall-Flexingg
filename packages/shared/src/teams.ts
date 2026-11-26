/**
 * Team challenges: the colour palette, the create-time team definition, and the pure maths that
 * turns individual scores into a team leaderboard. Kept free of server code so the web app and
 * the API agree on every number.
 */
import { z } from 'zod';
import type { ScoringMode } from './scoring.js';

/** Six clearly different colours that read on the dark theme. Team names always sit beside them. */
export const TEAM_COLORS = [
  { hex: '#ff6b6b', label: 'Coral' },
  { hex: '#ffb347', label: 'Amber' },
  { hex: '#5fe08a', label: 'Green' },
  { hex: '#4dd0e1', label: 'Cyan' },
  { hex: '#7a9cff', label: 'Blue' },
  { hex: '#e07aff', label: 'Violet' },
] as const;
export const TEAM_COLOR_HEXES: string[] = TEAM_COLORS.map((c) => c.hex);

export const TEAM_SCORING_LABELS = {
  avg: 'Team average',
  sum: 'Team total',
} as const;
export type TeamScoring = keyof typeof TEAM_SCORING_LABELS;
export const TEAM_SCORING_HINT = {
  avg: 'Average of everyone on the team who scored. Fair when teams are different sizes.',
  sum: 'Everyone’s scores added together. Bigger teams have an edge.',
} as const;

export const MIN_TEAMS = 2;
export const MAX_TEAMS = 6;

export const teamDefSchema = z.object({
  name: z.string().trim().min(1).max(24),
  color: z.string().refine((c) => TEAM_COLOR_HEXES.includes(c), 'Pick one of the team colours'),
});

/** Sent when creating a challenge with teams. */
export const teamsInputSchema = z
  .object({
    scoring: z.enum(['sum', 'avg']).default('avg'),
    teams: z.array(teamDefSchema).min(MIN_TEAMS).max(MAX_TEAMS),
    /** Which team (by position in `teams`) the creator plays on. */
    myTeam: z
      .number()
      .int()
      .min(0)
      .max(MAX_TEAMS - 1)
      .default(0),
  })
  .refine((v) => new Set(v.teams.map((t) => t.name.toLowerCase())).size === v.teams.length, {
    message: 'Give each team its own name',
    path: ['teams'],
  })
  .refine((v) => new Set(v.teams.map((t) => t.color)).size === v.teams.length, {
    message: 'Give each team its own colour',
    path: ['teams'],
  })
  .refine((v) => v.myTeam < v.teams.length, {
    message: 'Pick one of your teams',
    path: ['myTeam'],
  });
export type TeamsInput = z.input<typeof teamsInputSchema>;

/** Move people (joined members) into a team. */
export const moveTeamMembersSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(100),
});

/** One team on the leaderboard. */
export interface ChallengeTeam {
  id: string;
  name: string;
  color: string;
  /** Sum or average of members' scores. Null when nobody on the team has a score. */
  score: number | null;
  rank: number;
  /** Joined members. */
  memberIds: string[];
}

export interface TeamScoreRules {
  mode: TeamScoring;
  scoring: ScoringMode;
  lowerIsBetter: boolean;
}

export interface TeamScoreResult {
  teamId: string;
  score: number | null;
  rank: number;
}

/**
 * Team score = sum or average of the members' own scores; members with no score (null) are
 * ignored, and a team with no scored members has no score. Ranks follow the individual rules:
 * ties share a rank (next rank skipped), no score ranks last, and lower-is-better flips the order
 * (streaks are always higher-is-better). Race-to-goal teams are ranked by that same team score.
 */
export function computeTeamScores(
  rules: TeamScoreRules,
  teams: { id: string; memberScores: (number | null)[] }[],
): TeamScoreResult[] {
  const lower = rules.scoring !== 'streak' && rules.lowerIsBetter;
  const scored = teams.map((t) => {
    const vals = t.memberScores.filter((s): s is number => s != null && Number.isFinite(s));
    const total = vals.reduce((a, b) => a + b, 0);
    const score = vals.length === 0 ? null : rules.mode === 'sum' ? total : total / vals.length;
    return { teamId: t.id, score };
  });
  const cmp = (a: { score: number | null }, b: { score: number | null }) => {
    if (a.score == null && b.score == null) return 0;
    if (a.score == null) return 1;
    if (b.score == null) return -1;
    const diff = lower ? a.score - b.score : b.score - a.score;
    return Math.abs(diff) < 1e-9 ? 0 : diff;
  };
  const sorted = [...scored].sort(cmp);
  const out: TeamScoreResult[] = [];
  sorted.forEach((s, i) => {
    const prev = out[i - 1];
    out.push({ ...s, rank: prev && cmp(sorted[i - 1]!, s) === 0 ? prev.rank : i + 1 });
  });
  return out;
}

/**
 * Deal people into teams as evenly as possible (team sizes differ by at most one), in random
 * order. `random` is injectable for tests. Returns userId -> index of the team they go to.
 */
export function shuffleIntoTeams(
  userIds: string[],
  teamCount: number,
  random: () => number = Math.random,
): Map<string, number> {
  const order = [...userIds];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  // Start dealing at a random team so the extra person isn't always on team one.
  const offset = teamCount > 0 ? Math.floor(random() * teamCount) : 0;
  return new Map(order.map((id, i) => [id, (i + offset) % teamCount]));
}
