import { levelFor, type BadgeView } from '@gauntlet/shared';
import { describe, expect, it } from 'vitest';
import {
  earnedLine,
  endsText,
  groupCatalog,
  isCelebratory,
  pickShowcase,
  planCelebration,
  progressPct,
  xpGained,
} from './badges';

const T = (tier: number, count: number, earned: boolean[], xp = [10, 25, 60, 150]) =>
  Array.from({ length: count }, (_, i) => ({
    tier: i + 1,
    threshold: (i + 1) * 10,
    name: (count <= 1 ? null : (['bronze', 'silver', 'gold', 'platinum'] as const)[i]) ?? null,
    label: `Do ${(i + 1) * 10}`,
    earnedAt: earned[i] ? '2026-11-01T10:00:00.000Z' : null,
    xp: xp[i] ?? 25,
  }));

function badge(key: string, tier: number, count = 4, extra: Partial<BadgeView> = {}): BadgeView {
  return {
    key,
    name: key,
    description: 'Do it',
    family: 'movement',
    icon: 'shoe',
    imageUrl: null,
    secret: false,
    hidden: false,
    status: 'live',
    window: null,
    tiers: T(
      tier,
      count,
      Array.from({ length: count }, (_, i) => i < tier),
    ),
    tier,
    progress: null,
    earnedAt: tier ? '2026-11-01T10:00:00.000Z' : null,
    ...extra,
  };
}
const prog = (v: number): BadgeView['progress'] => ({
  value: v,
  target: 100,
  label: `${v} of 100`,
});

describe('groupCatalog', () => {
  it('puts earned first, then in-progress by % done, then locked, secrets apart', () => {
    const list = [
      badge('locked', 0),
      badge('half', 0, 4, { progress: prog(50) }),
      badge('almost', 0, 4, { progress: prog(90) }),
      badge('won', 2),
      badge('secret', 0, 1, { secret: true, hidden: true }),
    ];
    const g = groupCatalog(list, '2026-11-20');
    expect(g.earned.map((b) => b.key)).toEqual(['won']);
    expect(g.inProgress.map((b) => b.key)).toEqual(['almost', 'half']);
    expect(g.locked.map((b) => b.key)).toEqual(['locked']);
    expect(g.secret.map((b) => b.key)).toEqual(['secret']);
  });
  it('lifts running windowed badges into a limited section, and not ones that ended', () => {
    const run = badge('summer', 0, 1, { window: { start: '2026-11-01', end: '2026-11-30' } });
    const over = badge('old', 0, 1, { window: { start: '2026-09-01', end: '2026-09-30' } });
    const g = groupCatalog([run, over], '2026-11-20');
    expect(g.limited.map((b) => b.key)).toEqual(['summer']);
    expect(g.locked.map((b) => b.key)).toEqual(['old']);
  });
});

describe('showcase', () => {
  const list = [badge('a', 1), badge('b', 3), badge('c', 4), badge('d', 2), badge('e', 0)];
  it('uses the pinned ones in order, skipping unearned', () => {
    expect(pickShowcase(list, ['d', 'e', 'a']).map((b) => b.key)).toEqual(['d', 'a']);
  });
  it('falls back to the top three by tier', () => {
    expect(pickShowcase(list, []).map((b) => b.key)).toEqual(['c', 'b', 'd']);
  });
});

describe('celebration', () => {
  it('celebrates gold, platinum, one-tier secrets and limited-time badges only', () => {
    expect(isCelebratory(badge('x', 1))).toBe(false);
    expect(isCelebratory(badge('x', 2))).toBe(false);
    expect(isCelebratory(badge('x', 3))).toBe(true);
    expect(isCelebratory(badge('x', 4))).toBe(true);
    expect(isCelebratory(badge('x', 1, 1, { secret: true }))).toBe(true);
    expect(isCelebratory(badge('x', 1, 1))).toBe(false);
    expect(
      isCelebratory(badge('x', 1, 1, { window: { start: '2026-01-01', end: '2026-02-01' } })),
    ).toBe(true);
  });
  it('shows at most three full-screen and leaves the rest for a toast', () => {
    const list = [badge('p', 4), badge('g1', 3), badge('g2', 3), badge('g3', 3), badge('b', 1)];
    const plan = planCelebration(list, levelFor(0));
    expect(plan.full.map((b) => b.key)).toEqual(['p', 'g1', 'g2']);
    expect(plan.quiet.map((b) => b.key)).toEqual(['g3', 'b']);
  });
  it('adds up XP of tiers earned together and notices a level-up', () => {
    const b = badge('p', 2); // bronze + silver earned at once: 10 + 25
    expect(xpGained([b])).toBe(35);
    const plan = planCelebration([b], levelFor(60));
    expect(plan.xp).toBe(35);
    expect(plan.leveledUpFrom).toBe(1); // 25 xp was level 1, 60 is level 2
    expect(planCelebration([b], levelFor(40)).leveledUpFrom).toBeNull();
  });
});

describe('wording', () => {
  it('names the tier unless the badge has only one', () => {
    expect(earnedLine(badge('Long Haul', 3))).toBe('Gold · Long Haul');
    expect(earnedLine(badge('Early Bird', 1, 1))).toBe('Early Bird');
  });
  it('counts days left', () => {
    expect(endsText({ end: '2026-11-22' }, '2026-11-20')).toBe('Ends in 3 days');
    expect(endsText({ end: '2026-11-21' }, '2026-11-20')).toBe('Ends tomorrow');
    expect(endsText({ end: '2026-11-20' }, '2026-11-20')).toBe('Ends today');
  });
  it('clamps progress', () => {
    expect(progressPct({ progress: prog(250) })).toBe(1);
    expect(progressPct({ progress: null })).toBe(0);
  });
});
