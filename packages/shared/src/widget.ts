/**
 * What the Android home-screen widget and the Wear OS tile show. The app boils Today down to this
 * small snapshot and hands it to native code, which draws it without the app (or a network) being
 * available. Keeping the builder here makes the wording testable without a phone.
 */
import type { ChallengeSummary, TodayResponse } from './api.js';
import { formatRingGoal, formatRingValue, ringShowsUnit, ringsOfToday } from './dayStats.js';
import { DEFAULT_DISPLAY, type DisplayPrefs } from './format.js';
import { formatMetricValue } from './metrics.js';
import { ordinal } from './scoring.js';
import { SOLO_STATUS_LABELS } from './solo.js';

export interface WidgetChannel {
  value: number | null;
  goal: number | null;
}

/** One of the three rings as the widget draws it: its own label and text, already in the person's units. */
export interface WidgetRing {
  metric: string;
  /** "Steps", "Distance": the legend's label. */
  label: string;
  value: number | null;
  goal: number | null;
  /** "6,200" or "5.2 mi": the value, ready to print. */
  valueText: string;
  /** The goal the same way ("10,000", "6.2 mi"); the widget adds "of". */
  goalText: string;
}

export interface WidgetChallenge {
  id: string;
  name: string;
  /** My place, or null when I have no score yet. */
  rank: number | null;
  /** How many people are in it. */
  of: number;
  /** "2nd of 5" (or "No score yet"), for the widget's small text. */
  rankText: string;
  /** Gap or lead: "1,200 steps behind Maya". */
  line: string;
}

export interface WidgetSnapshot {
  /** ISO time the snapshot was made; native code shows "Updated 3h ago" from it. */
  updatedAt: string;
  /** The day the numbers are for (YYYY-MM-DD). */
  date: string;
  /**
   * The three rings the person chose (outer first). Native code reads these; `steps`, `activeCalories`
   * and `activeMinutes` below stay filled in for builds that predate configurable rings.
   */
  rings: WidgetRing[];
  steps: WidgetChannel;
  activeCalories: WidgetChannel;
  activeMinutes: WidgetChannel;
  challenge: WidgetChallenge | null;
}

type Display = Pick<DisplayPrefs, 'units' | 'locale'>;

function channel(today: TodayResponse, key: string): WidgetChannel {
  const m = today.metrics.find((x) => x.key === key);
  return { value: m?.value ?? null, goal: m?.goal != null && m.goal > 0 ? m.goal : null };
}

/** "2nd of 5", or a plain fallback before the person has a score. */
export function widgetRankText(rank: number | null, of: number): string {
  return rank == null ? 'No score yet' : `${ordinal(rank)} of ${of}`;
}

function challengeLine(c: ChallengeSummary, prefs: Display): string {
  const amount = (v: number) =>
    c.unit
      ? formatMetricValue(v, c, true, prefs)
      : `${formatMetricValue(v, c, false, prefs)} ${c.metricLabel.toLowerCase()}`;
  if (c.solo) {
    return c.solo.status === 'upcoming'
      ? 'Starts soon'
      : `${SOLO_STATUS_LABELS[c.solo.status]} · ${Math.round(c.solo.progress * 100)}% of the way`;
  }
  if (c.myScore == null || c.myRank == null) return 'No data yet';
  if (c.gap) {
    const first = c.gap.user.displayName.split(' ')[0] ?? c.gap.user.displayName;
    return `${amount(c.gap.amount)} ${c.gap.ahead ? 'behind' : 'ahead of'} ${first}`;
  }
  return `${amount(c.myScore)} so far`;
}

/** Only a challenge that is running now is worth a widget line. */
function widgetChallenge(c: ChallengeSummary | null, prefs: Display): WidgetChallenge | null {
  if (!c || c.status !== 'active') return null;
  return {
    id: c.id,
    name: c.name,
    rank: c.myRank,
    of: c.participantCount,
    rankText: c.solo ? 'Solo' : widgetRankText(c.myRank, c.participantCount),
    line: challengeLine(c, prefs),
  };
}

function widgetRings(today: TodayResponse, prefs: Display): WidgetRing[] {
  return ringsOfToday(today).map((r) => {
    const unit = ringShowsUnit(r.unit);
    return {
      metric: r.metric,
      label: r.label,
      value: r.value,
      goal: r.goal > 0 ? r.goal : null,
      valueText: formatRingValue(r, prefs, unit),
      goalText: formatRingGoal(r, prefs, unit),
    };
  });
}

export function buildWidgetSnapshot(
  today: TodayResponse,
  now: Date = new Date(),
  prefs: Display = DEFAULT_DISPLAY,
): WidgetSnapshot {
  return {
    updatedAt: now.toISOString(),
    date: today.date,
    rings: widgetRings(today, prefs),
    steps: channel(today, 'steps'),
    activeCalories: channel(today, 'active_calories'),
    activeMinutes: channel(today, 'active_minutes'),
    challenge: widgetChallenge(today.featured, prefs),
  };
}
