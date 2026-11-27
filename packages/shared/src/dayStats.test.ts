import { describe, expect, it } from 'vitest';
import {
  buildDay,
  buildRings,
  defaultGoal,
  formatRingGoal,
  formatRingValue,
  goalFromInput,
  goalPresets,
  goalToInput,
  goalUnitLabel,
  RING_LABELS,
  ringFraction,
  ringsOfToday,
} from './dayStats.js';
import { DEFAULT_RINGS, RING_METRICS, ringConfigSchema, ringsOf } from './rings.js';

describe('ring config', () => {
  it('needs three different stats', () => {
    const two = [DEFAULT_RINGS[0], DEFAULT_RINGS[0], DEFAULT_RINGS[1]];
    expect(ringConfigSchema.safeParse(two).success).toBe(false);
    expect(ringsOf(two)).toEqual(DEFAULT_RINGS);
  });
  it('has a label, goal presets and a default goal for every stat', () => {
    for (const m of RING_METRICS) {
      expect(RING_LABELS[m]).toBeTruthy();
      expect(goalPresets(m, 'metric').length).toBeGreaterThan(1);
      expect(goalPresets(m, 'imperial').length).toBeGreaterThan(1);
      expect(defaultGoal(m)).toBeGreaterThan(0);
    }
  });
});

describe('goal units', () => {
  it('shows km as miles and converts a typed goal back', () => {
    expect(goalToInput('distance', 10, 'metric')).toBe(10);
    expect(goalToInput('distance', 10, 'imperial')).toBe(6.2);
    expect(goalFromInput('distance', 5, 'imperial')).toBeCloseTo(8.04672, 4);
    expect(goalFromInput('distance', 5, 'metric')).toBe(5);
  });
  it('shows litres as fluid ounces', () => {
    expect(goalToInput('water', 2.5, 'imperial')).toBe(85);
    expect(goalFromInput('water', 64, 'imperial')).toBeCloseTo(1.893, 3);
    expect(goalUnitLabel('water', 'imperial')).toBe('fl oz');
    expect(goalUnitLabel('water', 'metric')).toBe('L');
  });
  it('keeps hours, steps and kcal as they are', () => {
    expect(goalToInput('sleep', 8, 'imperial')).toBe(8);
    expect(goalUnitLabel('sleep', 'metric')).toBe('hours');
    expect(goalUnitLabel('steps', 'metric')).toBe('steps');
    expect(goalToInput('steps', 10000, 'imperial')).toBe(10000);
  });
  it('converts weight lifted to pounds', () => {
    expect(goalToInput('lift_volume', 10000, 'imperial')).toBe(22046);
    expect(goalPresets('lift_volume', 'imperial')).toContain(20000);
  });
  it('round-trips the imperial presets to whole numbers', () => {
    for (const mi of goalPresets('distance', 'imperial'))
      expect(goalToInput('distance', goalFromInput('distance', mi, 'imperial'), 'imperial')).toBe(
        mi,
      );
  });
});

describe('rings', () => {
  const rows = [
    { date: '2026-11-26', metric: 'steps', value: 5000 },
    { date: '2026-11-26', metric: 'distance', value: 4 },
    { date: '2026-11-25', metric: 'steps', value: 9000 },
  ];
  it('reads each ring from the day', () => {
    const rings = buildRings(
      [
        { metric: 'distance', goal: 8 },
        { metric: 'steps', goal: 10_000 },
        { metric: 'sleep', goal: 8 },
      ],
      (m) => rows.find((r) => r.date === '2026-11-26' && r.metric === m)?.value ?? null,
    );
    expect(rings.map((r) => [r.metric, r.value, r.unit])).toEqual([
      ['distance', 4, 'km'],
      ['steps', 5000, ''],
      ['sleep', null, 'h'],
    ]);
    expect(ringFraction(rings[0]!)).toBe(0.5);
    expect(ringFraction(rings[2]!)).toBe(0);
  });
  it('falls back to the default three from old metrics', () => {
    const r = ringsOfToday({ metrics: [{ key: 'steps', value: 1234 }] });
    expect(r.map((x) => x.metric)).toEqual(['steps', 'active_calories', 'active_minutes']);
    expect(r[0]!.value).toBe(1234);
  });
  it('words values and goals in the viewer units', () => {
    const r = { metric: 'distance' as const, unit: 'km', value: 8.04672, goal: 10 };
    expect(formatRingValue(r)).toBe('8.0 km');
    expect(formatRingValue(r, { units: 'imperial', locale: 'en-US' })).toBe('5.0 mi');
    expect(formatRingGoal(r, { units: 'imperial', locale: 'en-US' })).toBe('6.2 mi');
    expect(formatRingGoal({ metric: 'steps', unit: '', goal: 10000 })).toBe('10,000');
  });
});

describe('buildDay', () => {
  const d = '2026-11-26';
  const rows = [
    { date: d, metric: 'steps', value: 7000 },
    { date: d, metric: 'sleep', value: 7.5 },
    { date: d, metric: 'calories_in', value: 1900 },
    { date: d, metric: 'goal_calories', value: 2200 },
    { date: d, metric: 'weight', value: 80.2 },
    { date: d, metric: 'lift_max:squat', value: 100 },
    { date: d, metric: 'custom:blood pressure', value: 120 },
    { date: d, metric: 'calorie_adherence', value: 90 },
    { date: '2026-11-25', metric: 'protein', value: 150 },
  ];
  const day = buildDay({ rows, date: d, today: d, config: DEFAULT_RINGS });
  it('groups the stats and skips empty sections and derived scores', () => {
    expect(day.isToday).toBe(true);
    expect(day.sections.map((s) => s.key)).toEqual([
      'activity',
      'sleep',
      'nutrition',
      'strength',
      'body',
      'custom',
    ]);
    const all = day.sections.flatMap((s) => s.stats.map((x) => x.key));
    expect(all).not.toContain('calorie_adherence');
    expect(all).not.toContain('protein');
    expect(all).not.toContain('goal_calories');
  });
  it('sets each stat against a ring goal or the own food goal', () => {
    const find = (k: string) => day.sections.flatMap((s) => s.stats).find((x) => x.key === k)!;
    expect(find('steps').goal).toBe(10_000);
    expect(find('calories_in').goal).toBe(2200);
    expect(find('sleep').goal).toBeNull();
    expect(find('lift_max:squat').label).toBe('Squat heaviest set');
    expect(find('custom:blood pressure').label).toBe('Blood Pressure');
  });
  it('has the three rings for that day', () => {
    expect(day.rings[0]).toMatchObject({ metric: 'steps', value: 7000 });
    expect(buildDay({ rows, date: '2026-11-25', today: d, config: DEFAULT_RINGS }).isToday).toBe(
      false,
    );
  });
});
