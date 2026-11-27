import { describe, expect, it } from 'vitest';
import { badgeRuleSchema, type BadgeRule } from './badges.js';
import { daysLeftInWindow, describeRule } from './badgeText.js';

const rules: Record<BadgeRule['type'], { rule: unknown; has: string }> = {
  lifetime_total: {
    rule: { type: 'lifetime_total', metric: 'steps', tiers: [100000, 1000000, 5000000, 10000000] },
    has: 'Lifetime steps: 100k · 1M · 5M · 10M',
  },
  best_period: {
    rule: { type: 'best_period', metric: 'steps', period: 'day', tiers: [20000, 30000] },
    has: 'Best day of steps: 20k · 30k',
  },
  streak: {
    rule: { type: 'streak', metric: 'steps', min: 10000, tiers: [7, 30] },
    has: 'Days in a row with 10k+ steps: 7 · 30',
  },
  count_days: {
    rule: {
      type: 'count_days',
      metric: 'active_minutes',
      min: 30,
      tiers: [20, 100],
      hours: { from: 5, to: 7 },
    },
    has: 'Days with 30 min+ active minutes, between 5 am and 7 am: 20 · 100',
  },
  single_activity: {
    rule: { type: 'single_activity', sport: 'run', measure: 'distance_km', tiers: [5, 10, 21.1] },
    has: 'One run, biggest distance: 5 km · 10 km · 21.1 km',
  },
  activity_count: {
    rule: { type: 'activity_count', sport: 'run', tiers: [10, 50], measure: 'distance_km', min: 5 },
    has: 'Number of runs of 5 km+: 10 · 50',
  },
  activity_total: {
    rule: { type: 'activity_total', sport: 'ride', measure: 'distance_km', tiers: [100, 500] },
    has: 'Total distance across rides: 100 km · 500 km',
  },
  challenge_result: {
    rule: { type: 'challenge_result', place: 1, minParticipants: 4, tiers: [1, 5] },
    has: 'Challenges won (4+ people): 1 · 5',
  },
  social: {
    rule: { type: 'social', event: 'reactions_sent', tiers: [50, 500] },
    has: 'Reactions sent: 50 · 500',
  },
  date_active: {
    rule: { type: 'date_active', month: 1, day: 1, metric: 'steps', min: 1000 },
    has: 'Active on 1 January: 1k+ steps',
  },
};

describe('describeRule', () => {
  for (const [type, { rule, has }] of Object.entries(rules)) {
    it(`words ${type} in plain English`, () => {
      const parsed = badgeRuleSchema.parse(rule);
      expect(parsed.type).toBe(type);
      expect(describeRule(parsed)).toBe(has);
    });
  }
  it('covers every rule type', () => {
    expect(Object.keys(rules).sort()).toEqual(
      badgeRuleSchema.options.map((o) => o.shape.type.value).sort(),
    );
  });
  it('adds the dates of a window and says "Total" instead of "Lifetime"', () => {
    const r = badgeRuleSchema.parse(rules.lifetime_total.rule);
    expect(describeRule(r, { start: '2026-07-01', end: '2026-08-31' })).toBe(
      'Total steps: 100k · 1M · 5M · 10M (1 Jul to 31 Aug 2026)',
    );
  });
  it('words lift metrics', () => {
    const r = badgeRuleSchema.parse({
      type: 'best_period',
      metric: 'lift_max:Bench Press',
      period: 'day',
      tiers: [60, 100],
    });
    expect(describeRule(r)).toBe('Best day of Bench Press heaviest lift: 60 kg · 100 kg');
  });
});

describe('daysLeftInWindow', () => {
  it('counts today, and floors at zero', () => {
    expect(daysLeftInWindow({ end: '2026-08-31' }, '2026-08-31')).toBe(1);
    expect(daysLeftInWindow({ end: '2026-09-02' }, '2026-08-31')).toBe(3);
    expect(daysLeftInWindow({ end: '2026-08-01' }, '2026-08-31')).toBe(0);
  });
});
