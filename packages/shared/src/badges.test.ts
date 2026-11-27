import { describe, expect, it } from 'vitest';
import {
  badgeDraftSchema,
  badgeRuleSchema,
  hourInRange,
  levelFor,
  ruleTiers,
  sportOf,
  tierName,
  xpForTier,
  xpToReach,
} from './badges.js';

describe('levels and XP', () => {
  it('level 1 needs nothing and each level costs more than the last', () => {
    expect(xpToReach(1)).toBe(0);
    for (let l = 2; l < 60; l++) expect(xpToReach(l + 1) - xpToReach(l)).toBeGreaterThan(0);
    const gaps = [2, 10, 30].map((l) => xpToReach(l + 1) - xpToReach(l));
    expect(gaps[0]!).toBeLessThan(gaps[1]!);
    expect(gaps[1]!).toBeLessThan(gaps[2]!);
  });
  it('levelFor is the inverse of xpToReach at the boundaries', () => {
    expect(levelFor(0)).toMatchObject({ level: 1, levelXp: 0, nextLevelXp: xpToReach(2) });
    const at = xpToReach(5);
    expect(levelFor(at).level).toBe(5);
    expect(levelFor(at - 1).level).toBe(4);
    expect(levelFor(at + 1)).toMatchObject({ level: 5, xp: at + 1 });
  });
  it('xpToReach(level) is reached exactly by levelFor', () => {
    for (let l = 1; l < 40; l++) expect(levelFor(xpToReach(l)).level).toBe(l);
  });
});

describe('tiers', () => {
  it('names tiers by position, none for a single-tier badge', () => {
    expect(tierName(1, 4)).toBe('bronze');
    expect(tierName(2, 4)).toBe('silver');
    expect(tierName(3, 3)).toBe('gold');
    expect(tierName(4, 4)).toBe('platinum');
    expect(tierName(1, 1)).toBeNull();
  });
  it('pays XP per tier, with a secret bonus on the first tier only and overrides', () => {
    expect(xpForTier(1, 4, false)).toBe(10);
    expect(xpForTier(4, 4, false)).toBe(150);
    expect(xpForTier(1, 1, false)).toBe(25);
    expect(xpForTier(1, 1, true)).toBe(40);
    expect(xpForTier(2, 3, true)).toBe(25);
    expect(xpForTier(2, 3, false, [5, 7])).toBe(7);
  });
});

describe('sportOf', () => {
  it.each([
    ['Morning Run', 'cardio', 'run'],
    ['Treadmill', 'cardio', 'run'],
    ['Jogging', 'cardio', 'run'],
    ['Evening walk', 'cardio', 'walk'],
    ['Hiking', 'cardio', 'hike'],
    ['Indoor Cycling', 'cardio', 'ride'],
    ['Spin class', 'cardio', 'ride'],
    ['Bike ride', 'cardio', 'ride'],
    ['Pool swim', 'cardio', 'swim'],
    ['Pilates', 'cardio', 'yoga'],
    ['Yoga flow', 'cardio', 'yoga'],
    ['Squat', 'strength', 'strength'],
    ['Gym session', 'cardio', 'strength'],
    ['Elliptical', 'cardio', 'cardio'],
    ['Rowing', 'cardio', 'cardio'],
    ['Pickleball', 'cardio', 'other'],
    ['Growth', 'cardio', 'other'],
  ])('%s (%s) is %s', (name, kind, sport) => {
    expect(sportOf(name, kind)).toBe(sport);
  });
});

describe('hourInRange', () => {
  it('is half open and wraps past midnight', () => {
    expect(hourInRange(0, { from: 0, to: 4 })).toBe(true);
    expect(hourInRange(4, { from: 0, to: 4 })).toBe(false);
    expect(hourInRange(23, { from: 22, to: 2 })).toBe(true);
    expect(hourInRange(1, { from: 22, to: 2 })).toBe(true);
    expect(hourInRange(12, { from: 22, to: 2 })).toBe(false);
  });
});

describe('rule schema', () => {
  it('accepts each rule type and reports its tiers', () => {
    const rules = [
      { type: 'lifetime_total', metric: 'steps', tiers: [1, 2] },
      { type: 'best_period', metric: 'distance', period: 'week', tiers: [5] },
      { type: 'streak', metric: 'steps', min: 10000, tiers: [7, 30] },
      {
        type: 'count_days',
        metric: 'lift_max:squat',
        min: 100,
        tiers: [3],
        hours: { from: 0, to: 4 },
      },
      { type: 'single_activity', sport: 'run', measure: 'distance_km', tiers: [5, 10] },
      { type: 'activity_count', sport: 'any', tiers: [10], hours: { from: 4, to: 6 } },
      { type: 'activity_total', sport: 'ride', measure: 'minutes', tiers: [600] },
      { type: 'challenge_result', place: 1, minParticipants: 5, tiers: [1] },
      { type: 'challenge_result', drama: 'comeback', tiers: [1] },
      { type: 'social', event: 'reactions_sent', tiers: [10, 50] },
      { type: 'date_active', month: 1, day: 1 },
    ];
    for (const r of rules)
      expect(badgeRuleSchema.safeParse(r).success, JSON.stringify(r)).toBe(true);
    expect(ruleTiers(badgeRuleSchema.parse(rules[2]))).toEqual([7, 30]);
    expect(ruleTiers(badgeRuleSchema.parse(rules[10]))).toEqual([1]);
  });
  it('rejects unknown metrics, non-increasing tiers, too many tiers and unknown types', () => {
    const bad = [
      { type: 'lifetime_total', metric: 'nope', tiers: [1] },
      { type: 'lifetime_total', metric: 'steps', tiers: [5, 5] },
      { type: 'lifetime_total', metric: 'steps', tiers: [] },
      { type: 'lifetime_total', metric: 'steps', tiers: [1, 2, 3, 4, 5] },
      { type: 'lifetime_total', metric: 'steps', tiers: [0] },
      { type: 'run_arbitrary_code', tiers: [1] },
      { type: 'social', event: 'nope', tiers: [1] },
      { type: 'streak', metric: 'steps', tiers: [1] },
    ];
    for (const r of bad)
      expect(badgeRuleSchema.safeParse(r).success, JSON.stringify(r)).toBe(false);
  });
  it('validates a draft and applies its defaults', () => {
    const d = badgeDraftSchema.parse({
      key: 'my-badge',
      name: 'My badge',
      description: 'Walk {n} steps.',
      family: 'movement',
      icon: 'shoe',
      rule: { type: 'lifetime_total', metric: 'steps', tiers: [100] },
    });
    expect(d).toMatchObject({
      secret: false,
      window: null,
      xp: null,
      countsManual: true,
      imageUrl: null,
    });
    expect(badgeDraftSchema.safeParse({ ...d, key: 'Bad Key' }).success).toBe(false);
    expect(badgeDraftSchema.safeParse({ ...d, icon: 'banana' }).success).toBe(false);
  });
});
