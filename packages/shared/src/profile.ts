/**
 * Profiles: trophies from finished challenges, all-time stats and milestone badges. The API works
 * out the numbers (apps/api/src/services/profile.ts); what's shared lives here so the web app and
 * the tests agree on labels and thresholds.
 */
import { addDays } from './dates.js';
import type { UserCard } from './api.js';

export interface Trophy {
  /** Null when the viewer can't see which challenge it was (a private one they weren't in). */
  challengeId: string | null;
  name: string;
  /** 1, 2 or 3. */
  rank: number;
  /** People who finished with a score. */
  field: number;
  endDate: string;
  metricLabel: string | null;
}

export interface AllTimeStats {
  /** First day Gauntlet has data for. */
  since: string | null;
  daysTracked: number;
  totals: {
    steps: number;
    distanceKm: number;
    activeMinutes: number;
    activeCalories: number;
    workouts: number;
    liftVolumeKg: number;
    liftSets: number;
    fastHours: number;
  };
  bests: {
    steps: number | null;
    distanceKm: number | null;
    liftVolumeKg: number | null;
    longestFastHours: number | null;
    /** Longest run of days with at least 10,000 steps. */
    stepStreakDays: number;
  };
}

export interface Milestone {
  key: string;
  family: MilestoneFamily;
  label: string;
  achieved: boolean;
  /** 0..1 toward this milestone. */
  progress: number;
}

export interface ProfileResponse {
  user: UserCard & {
    visibility: 'private' | 'public';
    memberSince: string;
  };
  trophies: {
    gold: number;
    silver: number;
    bronze: number;
    /** Newest first. */
    list: Trophy[];
  };
  /**
   * Null when this person keeps their stats to themselves (always present on your own profile).
   * `shared` says whether other people can see them.
   */
  stats: AllTimeStats | null;
  milestones: Milestone[] | null;
  shared: boolean;
}

export type MilestoneFamily = 'steps' | 'distance' | 'workouts' | 'lifting' | 'streak' | 'wins';

const LADDERS: Record<
  MilestoneFamily,
  {
    steps: number[];
    label: (n: number) => string;
    value: (s: AllTimeStats, wins: number) => number;
  }
> = {
  steps: {
    steps: [100_000, 500_000, 1_000_000, 5_000_000, 10_000_000],
    label: (n) => `${n >= 1_000_000 ? `${n / 1_000_000}M` : `${n / 1000}k`} steps`,
    value: (s) => s.totals.steps,
  },
  distance: {
    steps: [100, 500, 1000, 5000],
    label: (n) => `${n.toLocaleString('en-US')} km`,
    value: (s) => s.totals.distanceKm,
  },
  workouts: {
    steps: [10, 50, 100, 250, 500],
    label: (n) => `${n} workouts`,
    value: (s) => s.totals.workouts,
  },
  lifting: {
    steps: [10_000, 100_000, 500_000, 1_000_000],
    label: (n) => `${(n / 1000).toLocaleString('en-US')} t lifted`,
    value: (s) => s.totals.liftVolumeKg,
  },
  streak: {
    steps: [7, 30, 100, 365],
    label: (n) => `${n}-day 10k streak`,
    value: (s) => s.bests.stepStreakDays,
  },
  wins: {
    steps: [1, 5, 10, 25],
    label: (n) => (n === 1 ? 'First win' : `${n} wins`),
    value: (_s, wins) => wins,
  },
};

/**
 * For each family: every milestone reached, plus the next one to aim for (with progress). Families
 * with nothing reached and no progress at all are left out, so a new account isn't a wall of zeros.
 */
export function milestones(stats: AllTimeStats, challengesWon: number): Milestone[] {
  const out: Milestone[] = [];
  for (const family of Object.keys(LADDERS) as MilestoneFamily[]) {
    const ladder = LADDERS[family];
    const value = ladder.value(stats, challengesWon);
    if (value <= 0) continue;
    for (const target of ladder.steps) {
      const achieved = value >= target;
      out.push({
        key: `${family}:${target}`,
        family,
        label: ladder.label(target),
        achieved,
        progress: Math.min(1, value / target),
      });
      if (!achieved) break;
    }
  }
  return out;
}

/** Longest run of consecutive dates (YYYY-MM-DD, any order). */
export function longestRun(dates: string[]): number {
  const sorted = [...new Set(dates)].sort();
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of sorted) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}
