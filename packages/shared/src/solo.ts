/**
 * Solo challenges: a challenge against yourself. Four kinds, all scored with the same engine as
 * challenges against friends, plus a pass/fail status and a pace.
 *
 * - target:  reach a total (e.g. 100 km this month).
 * - average: keep a daily average at or above (or, for "lower is better" stats, at or below) a number.
 * - streak:  hit a daily target for N days in a row.
 * - improve: beat your own past by a percentage: your daily average (or best day, for heaviest
 *            lifts) over the challenge vs the same over the X days before it started.
 */
import { z } from 'zod';
import { addDays, listDates } from './dates.js';
import {
  computeStandings,
  countedDates,
  type DailyValue,
  type ScoringMode,
  type ScoringRules,
} from './scoring.js';

export const SOLO_KINDS = ['target', 'average', 'streak', 'improve'] as const;
export type SoloKind = (typeof SOLO_KINDS)[number];

export const BASELINE_CHOICES = [7, 14, 30, 60, 90] as const;

export const soloConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('target') }),
  z.object({ kind: z.literal('average') }),
  z.object({ kind: z.literal('streak'), days: z.number().int().min(2).max(366) }),
  z.object({
    kind: z.literal('improve'),
    /** How much better, in percent (10 = 10% more than before; with "down", 10% less). */
    changePct: z.number().positive().max(1000),
    direction: z.enum(['up', 'down']),
    /** Days before the start that make up "my past". */
    baselineDays: z.number().int().min(3).max(90),
  }),
]);
export type SoloConfig = z.infer<typeof soloConfigSchema>;

export const SOLO_LABELS: Record<SoloKind, { title: string; blurb: string }> = {
  target: {
    title: 'Hit a total',
    blurb: 'Reach a number by the end, like 100 km or 50,000 steps.',
  },
  average: { title: 'Daily average', blurb: 'Keep your daily average at a number.' },
  streak: { title: 'Streak', blurb: 'Hit a daily target for a number of days in a row.' },
  improve: { title: 'Beat my past self', blurb: 'Do better than you did over the days before.' },
};

/** The scoring mode a solo kind uses (so it shares the engine, graph and results). */
export function soloScoring(kind: SoloKind, opts: { heaviest?: boolean } = {}): ScoringMode {
  if (kind === 'target') return 'race_to_goal';
  if (kind === 'streak') return 'streak';
  if (kind === 'improve' && opts.heaviest) return 'best_day';
  return 'daily_avg';
}

export type SoloStatus = 'upcoming' | 'ahead' | 'on_track' | 'behind' | 'achieved' | 'missed';

export const SOLO_STATUS_LABELS: Record<SoloStatus, string> = {
  upcoming: 'Not started',
  ahead: 'Ahead',
  on_track: 'On track',
  behind: 'Behind',
  achieved: 'Achieved',
  missed: 'Missed',
};

export interface SoloProgress {
  kind: SoloKind;
  status: SoloStatus;
  /** 0..1 toward the goal. */
  progress: number;
  /** What is measured now: the total so far, the daily average, the best streak, or the % change. */
  current: number | null;
  /** The goal in the same unit (for improve: the % change wanted, signed by direction). */
  target: number | null;
  /** How the numbers are shown: the metric's own unit, a percentage, or days. */
  valueKind: 'metric' | 'pct' | 'days';
  /** target: what is still to go. */
  remaining: number | null;
  /** target: what each remaining day has to bring. */
  perDayNeeded: number | null;
  /** target: where an even pace would be by now. */
  expected: number | null;
  /** improve: what "my past" came to, and the days it covers. */
  baseline: { value: number; from: string; to: string; days: number } | null;
  direction: 'up' | 'down';
  daysTotal: number;
  daysElapsed: number;
  daysLeft: number;
}

interface Inputs {
  solo: SoloConfig;
  rules: ScoringRules;
  /** The person's daily values for the challenge (after any per-person transform). */
  days: DailyValue[];
  /** improve: the person's daily values for the days before the start. */
  baselineDays?: DailyValue[];
  today: string;
}

/** Longest run of days meeting the daily target, and the run ending today (or yesterday). */
function streaks(
  rules: ScoringRules,
  days: DailyValue[],
  today: string,
): { best: number; current: number; todayHit: boolean } {
  const byDate = new Map(days.map((d) => [d.date, d.value]));
  const goal = rules.goal ?? 0;
  const hits = (v: number | undefined) =>
    v != null && (rules.lowerIsBetter ? v <= goal : v >= goal);
  const dates = countedDates(rules);
  let best = 0;
  let run = 0;
  for (const d of dates) {
    run = hits(byDate.get(d)) ? run + 1 : 0;
    best = Math.max(best, run);
  }
  const todayHit = dates.includes(today) && hits(byDate.get(today));
  // A day that is not over yet does not break the run.
  const last = dates.at(-1);
  const current = last === today && !todayHit ? runEndingBefore(dates, hits, byDate) : run;
  return { best, current, todayHit };
}

function runEndingBefore(
  dates: string[],
  hits: (v: number | undefined) => boolean,
  byDate: Map<string, number>,
): number {
  let run = 0;
  for (let i = dates.length - 2; i >= 0; i--) {
    if (hits(byDate.get(dates[i]!))) run++;
    else break;
  }
  return run;
}

/** The daily-average (or best-day) figure over a window, with the leaderboard's own maths. */
function statOver(
  rules: ScoringRules,
  from: string,
  to: string,
  days: DailyValue[],
): { value: number | null; withData: number } {
  const standings = computeStandings({ ...rules, startDate: from, endDate: to, asOf: to }, [
    { userId: 'me', days },
  ]);
  const s = standings[0]!;
  return { value: s.score, withData: s.daysWithData };
}

export function soloProgress({
  solo,
  rules,
  days,
  baselineDays = [],
  today,
}: Inputs): SoloProgress {
  const all = listDates(rules.startDate, rules.endDate);
  const daysTotal = all.length;
  const started = today >= rules.startDate;
  const finished = today > rules.endDate;
  const daysElapsed = started ? countedDates(rules).length : 0;
  const daysLeft = finished ? 0 : Math.max(daysTotal - daysElapsed, 0);
  const direction: 'up' | 'down' =
    solo.kind === 'improve' ? solo.direction : rules.lowerIsBetter ? 'down' : 'up';
  const base: SoloProgress = {
    kind: solo.kind,
    status: started ? 'on_track' : 'upcoming',
    progress: 0,
    current: null,
    target: rules.goal ?? null,
    valueKind: 'metric',
    remaining: null,
    perDayNeeded: null,
    expected: null,
    baseline: null,
    direction,
    daysTotal,
    daysElapsed,
    daysLeft,
  };
  if (!started) return base;

  const standing = computeStandings(rules, [{ userId: 'me', days }])[0]!;
  const goal = rules.goal ?? 0;
  const meets = (v: number) => (direction === 'down' ? v <= goal : v >= goal);

  if (solo.kind === 'target') {
    const current = standing.score ?? 0;
    const expected = goal * (daysElapsed / daysTotal);
    const achieved = current >= goal;
    const status: SoloStatus = achieved
      ? 'achieved'
      : finished
        ? 'missed'
        : current >= expected * 1.05
          ? 'ahead'
          : current >= expected * 0.9
            ? 'on_track'
            : 'behind';
    return {
      ...base,
      status,
      current,
      expected,
      progress: goal > 0 ? Math.min(current / goal, 1) : 0,
      remaining: Math.max(goal - current, 0),
      perDayNeeded: daysLeft > 0 ? Math.max(goal - current, 0) / daysLeft : null,
    };
  }

  if (solo.kind === 'average') {
    const current = standing.score;
    if (current == null) return { ...base, status: finished ? 'missed' : 'on_track' };
    const good = meets(current);
    const progress =
      direction === 'down'
        ? current <= 0
          ? 1
          : Math.min(goal / current, 1)
        : goal > 0
          ? Math.min(current / goal, 1)
          : 0;
    const margin = direction === 'down' ? current <= goal * 0.95 : current >= goal * 1.05;
    return {
      ...base,
      current,
      progress,
      status: finished
        ? good
          ? 'achieved'
          : 'missed'
        : good
          ? margin
            ? 'ahead'
            : 'on_track'
          : 'behind',
      remaining: good ? 0 : Math.abs(goal - current),
    };
  }

  if (solo.kind === 'streak') {
    const { best, current, todayHit } = streaks(rules, days, today);
    const needed = solo.days;
    const possible = (todayHit ? current : current + 1) + daysLeft;
    const achieved = best >= needed;
    return {
      ...base,
      valueKind: 'days',
      current: best,
      target: needed,
      progress: Math.min(best / needed, 1),
      remaining: Math.max(needed - best, 0),
      status: achieved
        ? 'achieved'
        : finished || possible < needed
          ? 'missed'
          : current >= Math.min(needed, daysElapsed) && current > 0
            ? 'ahead'
            : 'on_track',
    };
  }

  // improve
  const from = addDays(rules.startDate, -solo.baselineDays);
  const to = addDays(rules.startDate, -1);
  const past = statOver({ ...rules, goal: null }, from, to, baselineDays);
  const baseline =
    past.value != null && past.withData > 0 && past.value > 0
      ? { value: past.value, from, to, days: solo.baselineDays }
      : null;
  const wanted = solo.direction === 'up' ? solo.changePct : -solo.changePct;
  if (!baseline || standing.score == null)
    return {
      ...base,
      valueKind: 'pct',
      target: wanted,
      baseline,
      status: finished ? 'missed' : 'on_track',
    };
  const pct = (standing.score / baseline.value - 1) * 100;
  const gain = solo.direction === 'up' ? pct : -pct;
  const met = gain >= solo.changePct;
  return {
    ...base,
    valueKind: 'pct',
    current: pct,
    target: wanted,
    baseline,
    progress: Math.min(Math.max(gain / solo.changePct, 0), 1),
    remaining: Math.max(solo.changePct - gain, 0),
    status: finished
      ? met
        ? 'achieved'
        : 'missed'
      : met
        ? 'ahead'
        : gain >= solo.changePct * 0.6
          ? 'on_track'
          : 'behind',
  };
}

/** The graph's reference line and unit for a solo challenge. */
export function soloGraph(
  solo: SoloConfig,
  goal: number | null,
  baseline: number | null,
): { target: number | null; valueKind: 'metric' | 'pct' | 'days' } {
  if (solo.kind === 'streak') return { target: solo.days, valueKind: 'days' };
  if (solo.kind === 'improve')
    return {
      target: solo.direction === 'up' ? solo.changePct : -solo.changePct,
      valueKind: baseline ? 'pct' : 'metric',
    };
  return { target: goal, valueKind: 'metric' };
}
