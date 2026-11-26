import { describe, expect, it } from 'vitest';
import { cleanStake, rematchName, stakeOutcome, stakeSchema, tallySeries } from './stakes.js';

describe('cleanStake / stakeSchema', () => {
  it('trims, collapses spaces and drops empties', () => {
    expect(cleanStake('  Loser   buys  coffee ')).toBe('Loser buys coffee');
    expect(cleanStake('   ')).toBeNull();
    expect(cleanStake(null)).toBeNull();
    expect(cleanStake(undefined)).toBeNull();
  });
  it('accepts 80 characters, refuses 81 and links', () => {
    expect(stakeSchema.safeParse('a'.repeat(80)).success).toBe(true);
    expect(stakeSchema.safeParse('a'.repeat(81)).success).toBe(false);
    expect(stakeSchema.safeParse('go to https://x.com').success).toBe(false);
    expect(stakeSchema.safeParse('www.x.com').success).toBe(false);
    expect(stakeSchema.safeParse(null).success).toBe(true);
    expect(stakeSchema.parse('  ')).toBeNull();
  });
});

describe('stakeOutcome', () => {
  const u = (id: string, rank: number, score: number | null = 1) => ({ id, rank, score });
  it('last place owes, first place is owed', () => {
    expect(stakeOutcome([u('a', 1), u('b', 2), u('c', 3)])).toEqual({
      winners: ['a'],
      losers: ['c'],
    });
  });
  it('ties for last all owe; ties for first all win', () => {
    expect(stakeOutcome([u('a', 1), u('b', 1), u('c', 3)])).toEqual({
      winners: ['a', 'b'],
      losers: ['c'],
    });
    expect(stakeOutcome([u('a', 1), u('b', 2), u('c', 2)]).losers).toEqual(['b', 'c']);
  });
  it('nobody owes when everyone tied, nobody scored, or only one played', () => {
    expect(stakeOutcome([u('a', 1), u('b', 1)]).losers).toEqual([]);
    expect(stakeOutcome([u('a', 1, null), u('b', 1, null)])).toEqual({ winners: [], losers: [] });
    expect(stakeOutcome([u('a', 1)])).toEqual({ winners: [], losers: [] });
  });
  it('a person with no score ranks last and owes', () => {
    expect(stakeOutcome([u('a', 1), u('b', 2, null)]).losers).toEqual(['b']);
  });
});

describe('tallySeries', () => {
  it('counts wins per person, keeping people with none', () => {
    const t = tallySeries([
      { participants: ['a', 'b'], winners: ['a'] },
      { participants: ['a', 'b'], winners: ['b'] },
      { participants: ['a', 'b'], winners: ['a'] },
    ]);
    expect(t).toEqual({
      rounds: 3,
      entries: [
        { userId: 'a', wins: 2 },
        { userId: 'b', wins: 1 },
      ],
    });
  });
  it('gives a tied round to every winner and lists newcomers with 0', () => {
    const t = tallySeries([
      { participants: ['a', 'b'], winners: ['a', 'b'] },
      { participants: ['a', 'b', 'c'], winners: ['c'] },
    ]);
    expect(t.entries.map((e) => [e.userId, e.wins])).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', 1],
    ]);
    expect(tallySeries([{ participants: ['a', 'b', 'c'], winners: [] }]).entries).toHaveLength(3);
    expect(tallySeries([]).rounds).toBe(0);
  });
});

describe('rematchName', () => {
  it('goes Rematch: X, then X (round 3), X (round 4)', () => {
    expect(rematchName('Step Wars')).toBe('Rematch: Step Wars');
    expect(rematchName('Rematch: Step Wars')).toBe('Step Wars (round 3)');
    expect(rematchName('Step Wars (round 3)')).toBe('Step Wars (round 4)');
    expect(rematchName('Step Wars (round 9)')).toBe('Step Wars (round 10)');
  });
  it('never stacks prefixes', () => {
    expect(rematchName('Rematch: Rematch: Step Wars')).toBe('Step Wars (round 3)');
  });
  it('fits in 60 characters', () => {
    const long = 'X'.repeat(60);
    expect(rematchName(long).length).toBe(60);
    expect(rematchName(`Rematch: ${'X'.repeat(51)}`).length).toBeLessThanOrEqual(60);
    expect(rematchName(`${'X'.repeat(55)} (round 3)`).length).toBeLessThanOrEqual(60);
  });
});
