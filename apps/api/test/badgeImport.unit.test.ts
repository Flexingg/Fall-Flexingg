import { badgeRuleSchema, BADGE_FAMILIES, BADGE_ICONS, BADGE_DAY_METRICS } from '@gauntlet/shared';
import { describe, expect, it } from 'vitest';
import { garminDate, normalizeGarminBadges } from '../src/services/badgeImport/garmin.js';
import { RULE_SCHEMAS, buildProposeBadgeTool } from '../src/services/badgeImport/toolSchema.js';

describe('Garmin badge normaliser', () => {
  it('keeps what we need, trims dates, ignores unknown fields', () => {
    const out = normalizeGarminBadges([
      {
        id: 7,
        name: ' Big Run ',
        description: 'Run far',
        image_path: 'x.png',
        points: 5,
        category: { id: 1, key: 'running', name: 'Running' },
        start_date: '2026-11-29T00:00:00.000000Z',
        end_date: null,
        extra: { a: 1 },
      },
    ]);
    expect(out).toEqual([
      {
        id: '7',
        name: 'Big Run',
        description: 'Run far',
        category: 'running',
        start: '2026-11-29',
        end: null,
      },
    ]);
  });
  it('tolerates missing fields and skips malformed or duplicate rows', () => {
    const out = normalizeGarminBadges([
      { id: 1, name: 'A' },
      { id: 'x', name: 'bad id' },
      { name: 'no id' },
      { id: 2 },
      null,
      'str',
      { id: 3, name: 'C', description: null, category: null, start_date: 'nonsense' },
      { id: 1, name: 'dupe' },
      { id: '4', name: 'D' },
    ]);
    expect(out.map((b) => b.id)).toEqual(['1', '3', '4']);
    expect(out[1]).toMatchObject({ description: '', category: null, start: null });
  });
  it('accepts a {data: []} wrapper and rejects non-lists', () => {
    expect(normalizeGarminBadges({ data: [{ id: 1, name: 'A' }] })).toHaveLength(1);
    expect(() => normalizeGarminBadges({ nope: true })).toThrow();
    expect(() => normalizeGarminBadges('html')).toThrow();
  });
  it('parses dates strictly', () => {
    expect(garminDate('2026-02-30T00:00:00Z')).toBeNull();
    expect(garminDate('2026-02-28T10:00:00Z')).toBe('2026-02-28');
    expect(garminDate(null)).toBeNull();
  });
});

describe('propose_badge tool schema', () => {
  const ruleTypes = badgeRuleSchema.options.map((o) => o.shape.type.value as string);
  it('has an entry for every rule type, and no extras', () => {
    expect(Object.keys(RULE_SCHEMAS).sort()).toEqual([...ruleTypes].sort());
  });
  it('lists every rule type in the rule field with a matching literal type', () => {
    const tool = buildProposeBadgeTool();
    const rule = (tool.input_schema.properties.draft.properties as any).rule.anyOf as any[];
    expect(rule.map((r) => r.properties.type.enum[0]).sort()).toEqual([...ruleTypes].sort());
  });
  it('mirrors the rule fields of badgeRuleSchema', () => {
    for (const opt of badgeRuleSchema.options) {
      const t = opt.shape.type.value as string;
      const props = Object.keys(RULE_SCHEMAS[t]!.properties as object).sort();
      expect(props, t).toEqual(Object.keys(opt.shape).sort());
    }
  });
  it('takes enums from the shared constants', () => {
    const d = buildProposeBadgeTool().input_schema.properties.draft.properties as any;
    expect(d.family.enum).toEqual([...BADGE_FAMILIES]);
    expect(d.icon.enum).toEqual([...BADGE_ICONS]);
    expect(JSON.stringify(RULE_SCHEMAS.lifetime_total)).toContain(BADGE_DAY_METRICS[0]);
    expect(buildProposeBadgeTool().input_schema.required).toEqual(['decision', 'reason']);
  });
});
