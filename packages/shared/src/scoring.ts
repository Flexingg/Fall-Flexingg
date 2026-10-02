import { listDates, minDate } from './dates.js';
import type { MetricAggregate } from './metrics.js';

/**
 * How a challenge is won.
 * - total: biggest total over the challenge (average for avg-type metrics like sleep).
 * - race_to_goal: first to reach `goal` (cumulative). Sum metrics only.
 * - daily_avg: best average per elapsed day; days without data count as 0.
 * - best_day: best single day.
 * - streak: longest run of consecutive days hitting `goal`.
 */
export const SCORING_MODES = ['total', 'race_to_goal', 'daily_avg', 'best_day', 'streak'] as const;
export type ScoringMode = (typeof SCORING_MODES)[number];

export const SCORING_LABELS: Record<ScoringMode, string> = {
  total: 'Biggest total',
  race_to_goal: 'Race to target',
  daily_avg: 'Best daily average',
  best_day: 'Best single day',
  streak: 'Longest streak',
};

/** The label for a way of winning, worded for the metric (running % figures read differently). */
export function scoringLabel(mode: ScoringMode, aggregate: MetricAggregate): string {
  if (aggregate === 'last' && mode === 'total') return 'Furthest along';
  if (aggregate === 'last' && mode === 'race_to_goal') return 'First to reach';
  return SCORING_LABELS[mode];
}

export interface DailyValue {
  date: string;
  value: number;
}

export interface ParticipantSeries {
  userId: string;
  days: DailyValue[];
}

export interface ScoringRules {
  scoring: ScoringMode;
  aggregate: MetricAggregate;
  lowerIsBetter: boolean;
  /** Required for race_to_goal (cumulative target) and streak (daily threshold). */
  goal?: number | null;
  startDate: string;
  endDate: string;
  /** Last day to count, normally "today" in the challenge time zone. */
  asOf: string;
}

export interface Standing {
  userId: string;
  rank: number;
  /** The value the ranking is based on. Null when the participant has no data. */
  score: number | null;
  /** 0..1 progress toward the goal, when the mode has one. */
  progress: number | null;
  /** Date the goal was reached (race_to_goal only). */
  reachedGoalOn: string | null;
  /** Value on `asOf`, for "today" columns. */
  todayValue: number | null;
  /** Days within the window that had data. */
  daysWithData: number;
}

export function validateRules(
  rules: Pick<ScoringRules, 'scoring' | 'aggregate' | 'goal'>,
): string | null {
  if (rules.scoring === 'race_to_goal') {
    if (rules.aggregate === 'avg')
      return 'Race to target only works with metrics that add up (steps, distance…).';
    if (!rules.goal || rules.goal <= 0) return 'Race to target needs a goal.';
  }
  if (rules.scoring === 'streak' && (rules.goal == null || rules.goal <= 0)) {
    return 'A streak needs a daily target.';
  }
  return null;
}

/** Window of days that currently count: start .. min(end, asOf). */
export function countedDates(
  rules: Pick<ScoringRules, 'startDate' | 'endDate' | 'asOf'>,
): string[] {
  return listDates(rules.startDate, minDate(rules.endDate, rules.asOf));
}

interface Scored {
  userId: string;
  score: number | null;
  progress: number | null;
  reachedGoalOn: string | null;
  todayValue: number | null;
  daysWithData: number;
}

export function computeStandings(
  rules: ScoringRules,
  participants: ParticipantSeries[],
): Standing[] {
  const dates = countedDates(rules);
  const dateSet = new Set(dates);
  const better = (a: number, b: number) => (rules.lowerIsBetter ? a < b : a > b);

  const scored: Scored[] = participants.map((p) => {
    const byDate = new Map<string, number>();
    for (const d of p.days) {
      if (dateSet.has(d.date) && Number.isFinite(d.value)) byDate.set(d.date, d.value);
    }
    const values = dates.filter((d) => byDate.has(d)).map((d) => byDate.get(d)!);
    const daysWithData = values.length;
    const todayValue = byDate.get(rules.asOf) ?? null;
    const base = { userId: p.userId, todayValue, daysWithData };

    if (daysWithData === 0) {
      const zero =
        rules.aggregate === 'sum' && !rules.lowerIsBetter && rules.scoring !== 'best_day'
          ? 0
          : null;
      return {
        ...base,
        score: rules.scoring === 'streak' ? 0 : zero,
        progress: rules.goal ? 0 : null,
        reachedGoalOn: null,
      };
    }

    const sum = values.reduce((a, b) => a + b, 0);
    const mean = sum / values.length;

    switch (rules.scoring) {
      case 'total': {
        const score =
          rules.aggregate === 'sum' ? sum : rules.aggregate === 'last' ? values.at(-1)! : mean;
        return { ...base, score, progress: progressOf(score, rules), reachedGoalOn: null };
      }
      case 'daily_avg': {
        const score = rules.aggregate === 'sum' ? sum / Math.max(dates.length, 1) : mean;
        return { ...base, score, progress: progressOf(score, rules), reachedGoalOn: null };
      }
      case 'best_day': {
        const score = values.reduce((best, v) => (better(v, best) ? v : best));
        return { ...base, score, progress: progressOf(score, rules), reachedGoalOn: null };
      }
      case 'race_to_goal': {
        // "last" metrics (e.g. % toward a weight target) race on the value itself.
        const isLast = rules.aggregate === 'last';
        let cumulative = 0;
        let reachedGoalOn: string | null = null;
        for (const d of dates) {
          const v = byDate.get(d);
          cumulative = isLast ? (v ?? cumulative) : cumulative + (v ?? 0);
          if (reachedGoalOn == null && rules.goal != null && cumulative >= rules.goal)
            reachedGoalOn = d;
        }
        const score = isLast ? values.at(-1)! : sum;
        return {
          ...base,
          score,
          progress: rules.goal ? Math.min(Math.max(score, 0) / rules.goal, 1) : null,
          reachedGoalOn,
        };
      }
      case 'streak': {
        const goal = rules.goal ?? 0;
        const hits = (v: number) => (rules.lowerIsBetter ? v <= goal : v >= goal);
        let best = 0;
        let run = 0;
        for (const d of dates) {
          const v = byDate.get(d);
          run = v != null && hits(v) ? run + 1 : 0;
          best = Math.max(best, run);
        }
        return {
          ...base,
          score: best,
          progress: dates.length ? best / dates.length : 0,
          reachedGoalOn: null,
        };
      }
    }
  });

  scored.sort((a, b) => compareScored(a, b, rules));

  const standings: Standing[] = [];
  scored.forEach((s, i) => {
    const prev = standings[i - 1];
    const tied = prev && i > 0 && compareScored(scored[i - 1]!, s, rules) === 0;
    standings.push({ ...s, rank: tied ? prev.rank : i + 1 });
  });
  return standings;
}

function progressOf(score: number, rules: ScoringRules): number | null {
  if (!rules.goal || rules.goal <= 0) return null;
  if (rules.lowerIsBetter) return score <= 0 ? 1 : Math.min(rules.goal / score, 1);
  return Math.min(score / rules.goal, 1);
}

/** Negative when `a` ranks ahead of `b`. */
function compareScored(a: Scored, b: Scored, rules: ScoringRules): number {
  if (rules.scoring === 'race_to_goal') {
    if (a.reachedGoalOn && b.reachedGoalOn && a.reachedGoalOn !== b.reachedGoalOn) {
      return a.reachedGoalOn < b.reachedGoalOn ? -1 : 1;
    }
    if (a.reachedGoalOn && !b.reachedGoalOn) return -1;
    if (!a.reachedGoalOn && b.reachedGoalOn) return 1;
  }
  if (a.score == null && b.score == null) return 0;
  if (a.score == null) return 1;
  if (b.score == null) return -1;
  // Streaks are always "more is better", whatever the metric.
  const lower = rules.scoring !== 'streak' && rules.lowerIsBetter;
  const diff = lower ? a.score - b.score : b.score - a.score;
  return Math.abs(diff) < 1e-9 ? 0 : diff;
}

/** Ordinal suffix: 1 -> "1st". */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export interface ProgressSeries {
  userId: string;
  /** Score as of each date in `dates`, or null while the person has no score yet. */
  values: (number | null)[];
}

/**
 * Each person's score at the end of every day from the start to `rules.asOf`, worked out with the
 * leaderboard's own rules, so the last point always equals the current score.
 */
export function progressSeries(
  rules: ScoringRules,
  participants: ParticipantSeries[],
): { dates: string[]; series: ProgressSeries[] } {
  const dates = countedDates(rules);
  const series = participants.map((p) => ({ userId: p.userId, values: [] as (number | null)[] }));
  for (const date of dates) {
    const standings = computeStandings({ ...rules, asOf: date }, participants);
    for (const s of series)
      s.values.push(standings.find((x) => x.userId === s.userId)?.score ?? null);
  }
  return { dates, series };
}
