/**
 * Side bets and rematch series: the pure parts. A stake is only ever a short line of text ("Loser
 * buys coffee"); Gauntlet never handles money. Kept free of server code so the API and the web app
 * agree on who owes what and on the running series record.
 */
import { z } from 'zod';
import type { PublicUser } from './api.js';

export const STAKE_MAX = 80;
export const STAKE_SUGGESTIONS = [
  'Loser buys coffee',
  'Loser picks the next challenge',
  'Loser posts a selfie',
] as const;

/** Trim, collapse runs of whitespace and treat an empty string as "no side bet". */
export function cleanStake(raw: string | null | undefined): string | null {
  const s = (raw ?? '').replace(/\s+/g, ' ').trim();
  return s ? s : null;
}

/** Text only: no links, so a side bet can't be used to push people somewhere. */
const LINK = /(https?:\/\/|www\.)/i;

/** A side bet as sent by the app: optional, trimmed, at most 80 characters, no links. */
export const stakeSchema = z
  .string()
  .nullable()
  .transform((v) => cleanStake(v))
  .refine(
    (v) => v == null || v.length <= STAKE_MAX,
    `Keep the side bet under ${STAKE_MAX} characters`,
  )
  .refine((v) => v == null || !LINK.test(v), 'A side bet is just text, no links');

/** A unit that finishes somewhere in the standings: a person, or a team in a team challenge. */
export interface RankedUnit {
  id: string;
  rank: number;
  score: number | null;
}

/**
 * Who won and who lost. Winners share first place; losers share last place (the "loser buys
 * coffee" person). With fewer than two units, nobody scored, or everybody tied for first, there is
 * no loser.
 */
export function stakeOutcome(units: RankedUnit[]): { winners: string[]; losers: string[] } {
  if (units.length < 2 || !units.some((u) => u.score != null)) return { winners: [], losers: [] };
  const winners = units.filter((u) => u.rank === 1 && u.score != null).map((u) => u.id);
  const last = Math.max(...units.map((u) => u.rank));
  const losers = last > 1 ? units.filter((u) => u.rank === last).map((u) => u.id) : [];
  return { winners, losers };
}

/** One finished round of a rematch chain. */
export interface SeriesRound {
  participants: string[];
  winners: string[];
}

export interface SeriesTally {
  rounds: number;
  /** Everyone who played, most wins first (ties keep the order they first appeared in). */
  entries: { userId: string; wins: number }[];
}

/** Wins per person across finished rounds. A tied round gives every winner a win. */
export function tallySeries(rounds: SeriesRound[]): SeriesTally {
  const wins = new Map<string, number>();
  for (const r of rounds) {
    for (const id of r.participants) if (!wins.has(id)) wins.set(id, 0);
    for (const id of new Set(r.winners)) wins.set(id, (wins.get(id) ?? 0) + 1);
  }
  const entries = [...wins].map(([userId, w]) => ({ userId, wins: w }));
  // Array sort is stable, so first-appearance order breaks ties.
  entries.sort((a, b) => b.wins - a.wins);
  return { rounds: rounds.length, entries };
}

/** The running record across a chain of rematches, as the app shows it. */
export interface RematchSeries {
  /** Finished rounds counted so far. */
  rounds: number;
  /** Which round this challenge is in the chain (1 for the original). */
  position: number;
  /** How many challenges the chain holds, finished or not. */
  total: number;
  entries: { user: PublicUser; wins: number; isMe: boolean }[];
}

/** The side bet on a finished challenge: who owes it and whether it has been settled. */
export interface StakeInfo {
  settledAt: string | null;
  /** People who finished last (everyone on the losing team(s) in a team challenge). */
  owedBy: PublicUser[];
  /** People who won, who the bet is owed to. */
  owedTo: PublicUser[];
  /** The viewer is the creator or a winner, so they can mark it paid up. */
  canSettle: boolean;
}

export const settleStakeSchema = z.object({ settled: z.boolean().default(true) });

const PREFIX = 'Rematch: ';
const ROUND = /^(.*) \(round (\d+)\)$/;
const NAME_MAX = 60;

/**
 * The name for the next round. The second round is "Rematch: X"; after that "X (round 3)", "X
 * (round 4)"… Prefixes never stack, and a long name is shortened so the whole thing fits.
 */
export function rematchName(name: string): string {
  let base = name.trim();
  let round = 1;
  while (base.startsWith(PREFIX)) {
    base = base.slice(PREFIX.length).trim();
    round = 2;
  }
  const m = ROUND.exec(base);
  if (m) {
    base = m[1]!.trim();
    round = Number(m[2]);
  }
  const next = round + 1;
  if (next === 2) return `${PREFIX}${base}`.slice(0, NAME_MAX);
  const suffix = ` (round ${next})`;
  return `${base.slice(0, NAME_MAX - suffix.length).trimEnd()}${suffix}`;
}
