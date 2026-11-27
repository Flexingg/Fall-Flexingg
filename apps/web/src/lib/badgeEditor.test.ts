import { badgeRuleSchema, type BadgeRule } from '@gauntlet/shared';
import { describe, expect, it } from 'vitest';
import {
  defaultFields,
  draftToForm,
  emptyForm,
  fieldsToRule,
  keyFromName,
  RULE_TYPES,
  ruleToFields,
  validateDraft,
} from './badgeEditor';

const samples: BadgeRule[] = [
  { type: 'lifetime_total', metric: 'steps', tiers: [100000, 1000000] },
  { type: 'lifetime_total', metric: 'lift_max:Bench Press', tiers: [60, 100] },
  { type: 'best_period', metric: 'steps', period: 'week', tiers: [70000] },
  { type: 'streak', metric: 'steps', min: 10000, tiers: [7, 30] },
  { type: 'count_days', metric: 'active_minutes', min: 30, tiers: [20], hours: { from: 5, to: 7 } },
  { type: 'single_activity', sport: 'run', measure: 'distance_km', tiers: [5, 10] },
  { type: 'activity_count', sport: 'ride', tiers: [10], measure: 'distance_km', min: 20 },
  { type: 'activity_count', sport: 'swim', tiers: [10, 50] },
  { type: 'activity_total', sport: 'ride', measure: 'distance_km', tiers: [100] },
  { type: 'challenge_result', place: 1, minParticipants: 4, teamOnly: true, tiers: [1, 5] },
  { type: 'challenge_result', drama: 'comeback', tiers: [1] },
  { type: 'social', event: 'reactions_sent', tiers: [50, 500] },
  { type: 'date_active', month: 1, day: 1, metric: 'steps', min: 1000 },
];

describe('rule builder fields', () => {
  it('has a builder for every rule type', () => {
    const types = badgeRuleSchema.options.map((o) => o.shape.type.value).sort();
    expect(RULE_TYPES.map((t) => t.value).sort()).toEqual(types);
    for (const t of types) expect(defaultFields(t).type).toBe(t);
  });
  for (const rule of samples)
    it(`round-trips ${rule.type} ${JSON.stringify(rule).length}`, () => {
      const back = fieldsToRule(ruleToFields(rule));
      expect(badgeRuleSchema.parse(back)).toEqual(badgeRuleSchema.parse(rule));
    });
});

describe('validateDraft', () => {
  const good = () => {
    const f = emptyForm();
    f.name = 'Million Stepper';
    f.key = keyFromName(f.name);
    f.description = 'Walk {n} steps in total.';
    f.rule = ruleToFields(samples[0]!);
    return f;
  };
  it('accepts a good form', () => {
    const r = validateDraft(good());
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.draft.rule).toMatchObject({ type: 'lifetime_total', tiers: [100000, 1000000] });
  });
  it('says what is wrong in plain words', () => {
    const f = good();
    f.name = 'x';
    f.description = '';
    f.key = 'Bad Key';
    f.rule.tiers = ['10', '5'];
    const r = validateDraft(f);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.name).toMatch(/2 to 40/);
      expect(r.errors.description).toMatch(/4 to 160/);
      expect(r.errors.key).toMatch(/lowercase/);
      expect(r.errors.rule).toBe('Each tier must be bigger than the one before.');
    }
  });
  it('wants numbers in the rule and a sensible window', () => {
    const f = good();
    f.rule.tiers = [''];
    f.limited = true;
    f.windowStart = '2026-08-31';
    f.windowEnd = '2026-08-01';
    const r = validateDraft(f);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.rule).toMatch(/1 to 4 tiers/);
      expect(r.errors.window).toMatch(/end date/);
    }
  });
  it('makes keys from names', () => {
    expect(keyFromName("Early Bird's Run!")).toBe('early-bird-s-run');
  });
});
