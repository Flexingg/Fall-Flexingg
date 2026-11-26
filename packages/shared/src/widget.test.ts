import { describe, expect, it } from 'vitest';
import type { ChallengeSummary, TodayResponse } from './api.js';
import { buildWidgetSnapshot, widgetRankText } from './widget.js';

const now = new Date('2026-11-26T09:30:00Z');
const m = (key: string, value: number | null, goal: number | null) => ({
  key,
  label: key,
  value,
  unit: '',
  goal,
});
const user = (displayName: string) => ({ id: displayName, displayName }) as never;

function challenge(over: Partial<ChallengeSummary> = {}): ChallengeSummary {
  return {
    id: 'c1',
    name: 'November steps',
    metric: 'steps',
    metricLabel: 'Steps',
    unit: 'steps',
    decimals: 0,
    status: 'active',
    participantCount: 5,
    myRank: 2,
    myScore: 90_000,
    gap: { user: user('Maya Chen'), amount: 1200, ahead: true },
    solo: null,
    ...over,
  } as ChallengeSummary;
}

const today = (over: Partial<TodayResponse> = {}): TodayResponse =>
  ({
    date: '2026-11-26',
    lastSyncedAt: null,
    metrics: [
      m('steps', 6200, 10_000),
      m('active_calories', 310, 500),
      m('active_minutes', 25, 30),
      m('sleep', 7, 8),
    ],
    featured: challenge(),
    hasSources: true,
    ...over,
  }) as TodayResponse;

describe('buildWidgetSnapshot', () => {
  it('reads the three rings and the featured challenge', () => {
    const s = buildWidgetSnapshot(today(), now);
    expect(s.updatedAt).toBe('2026-11-26T09:30:00.000Z');
    expect(s.steps).toEqual({ value: 6200, goal: 10_000 });
    expect(s.activeCalories).toEqual({ value: 310, goal: 500 });
    expect(s.activeMinutes).toEqual({ value: 25, goal: 30 });
    expect(s.challenge).toMatchObject({
      id: 'c1',
      name: 'November steps',
      rank: 2,
      of: 5,
      rankText: '2nd of 5',
      line: '1,200 steps behind Maya',
    });
  });

  it('copes with missing metrics and goals', () => {
    const s = buildWidgetSnapshot(
      today({ metrics: [m('steps', null, null), m('active_minutes', 12, 0)] as never }),
      now,
    );
    expect(s.steps).toEqual({ value: null, goal: null });
    expect(s.activeCalories).toEqual({ value: null, goal: null });
    expect(s.activeMinutes).toEqual({ value: 12, goal: null });
  });

  it('has no challenge when none is featured or it is not running', () => {
    expect(buildWidgetSnapshot(today({ featured: null }), now).challenge).toBeNull();
    expect(
      buildWidgetSnapshot(today({ featured: challenge({ status: 'completed' }) }), now).challenge,
    ).toBeNull();
  });

  it('words the lead, no score and no gap cases', () => {
    const lead = challenge({ myRank: 1, gap: { user: user('Dre'), amount: 300, ahead: false } });
    expect(buildWidgetSnapshot(today({ featured: lead }), now).challenge?.line).toBe(
      '300 steps ahead of Dre',
    );
    const none = challenge({ myRank: null, myScore: null, gap: null });
    const c = buildWidgetSnapshot(today({ featured: none }), now).challenge;
    expect(c?.rank).toBeNull();
    expect(c?.rankText).toBe('No score yet');
    expect(c?.line).toBe('No data yet');
    const alone = challenge({ gap: null });
    expect(buildWidgetSnapshot(today({ featured: alone }), now).challenge?.line).toBe(
      '90,000 steps so far',
    );
  });
});

describe('widgetRankText', () => {
  it('uses ordinals', () => {
    expect(widgetRankText(1, 3)).toBe('1st of 3');
    expect(widgetRankText(3, 12)).toBe('3rd of 12');
    expect(widgetRankText(null, 3)).toBe('No score yet');
  });
});
