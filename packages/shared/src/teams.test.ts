import { describe, expect, it } from 'vitest';
import { nextRoundDates } from './recurring.js';
import { computeTeamScores, shuffleIntoTeams, teamsInputSchema } from './teams.js';

const rules = { mode: 'avg', scoring: 'total', lowerIsBetter: false } as const;

describe('computeTeamScores', () => {
  it('sums or averages, ignoring members with no score', () => {
    const teams = [
      { id: 'a', memberScores: [10, 20, null] },
      { id: 'b', memberScores: [20] },
    ];
    const avg = computeTeamScores(rules, teams);
    expect(avg.find((t) => t.teamId === 'a')).toMatchObject({ score: 15, rank: 2 });
    expect(avg.find((t) => t.teamId === 'b')).toMatchObject({ score: 20, rank: 1 });
    const sum = computeTeamScores({ ...rules, mode: 'sum' }, teams);
    expect(sum.find((t) => t.teamId === 'a')).toMatchObject({ score: 30, rank: 1 });
    expect(sum.find((t) => t.teamId === 'b')).toMatchObject({ score: 20, rank: 2 });
  });

  it('a team with nobody scored has no score and ranks last', () => {
    const r = computeTeamScores(rules, [
      { id: 'a', memberScores: [null, null] },
      { id: 'b', memberScores: [] },
      { id: 'c', memberScores: [1] },
    ]);
    expect(r.find((t) => t.teamId === 'c')!.rank).toBe(1);
    expect(r.filter((t) => t.score == null).map((t) => t.rank)).toEqual([2, 2]);
  });

  it('ties share a rank and skip the next', () => {
    const r = computeTeamScores(rules, [
      { id: 'a', memberScores: [5] },
      { id: 'b', memberScores: [5] },
      { id: 'c', memberScores: [1] },
    ]);
    expect(r.map((t) => t.rank)).toEqual([1, 1, 3]);
  });

  it('lower is better puts the smallest first, except streaks', () => {
    const teams = [
      { id: 'a', memberScores: [60] },
      { id: 'b', memberScores: [50] },
    ];
    const low = computeTeamScores({ ...rules, lowerIsBetter: true }, teams);
    expect(low.find((t) => t.teamId === 'b')!.rank).toBe(1);
    const streak = computeTeamScores({ ...rules, lowerIsBetter: true, scoring: 'streak' }, teams);
    expect(streak.find((t) => t.teamId === 'a')!.rank).toBe(1);
  });
});

describe('shuffleIntoTeams', () => {
  it('deals evenly', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const plan = shuffleIntoTeams(ids, 3);
    expect(plan.size).toBe(7);
    const counts = [0, 0, 0];
    for (const t of plan.values()) counts[t]!++;
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });
});

describe('teamsInputSchema', () => {
  const t = (name: string, color: string) => ({ name, color });
  it('needs 2-6 uniquely named, uniquely coloured teams', () => {
    expect(teamsInputSchema.safeParse({ teams: [t('A', '#ff6b6b')] }).success).toBe(false);
    expect(
      teamsInputSchema.safeParse({ teams: [t('A', '#ff6b6b'), t('a', '#ffb347')] }).success,
    ).toBe(false);
    expect(
      teamsInputSchema.safeParse({ teams: [t('A', '#ff6b6b'), t('B', '#ff6b6b')] }).success,
    ).toBe(false);
    expect(
      teamsInputSchema.safeParse({ teams: [t('A', '#123456'), t('B', '#ffb347')] }).success,
    ).toBe(false);
    const ok = teamsInputSchema.parse({ teams: [t('A', '#ff6b6b'), t('B', '#ffb347')] });
    expect(ok.scoring).toBe('avg');
  });
});

describe('nextRoundDates', () => {
  it('starts the day after and keeps the length', () => {
    expect(nextRoundDates('2026-10-05', '2026-10-11')).toEqual({
      start: '2026-10-12',
      end: '2026-10-18',
    });
    expect(nextRoundDates('2026-10-31', '2026-10-31')).toEqual({
      start: '2026-11-01',
      end: '2026-11-01',
    });
  });
});
