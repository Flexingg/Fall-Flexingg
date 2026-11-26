/**
 * What the Android home-screen widget and the Wear OS tile show. The app boils Today down to this
 * small snapshot and hands it to native code, which draws it without the app (or a network) being
 * available. Keeping the builder here makes the wording testable without a phone.
 */
import type { ChallengeSummary, TodayResponse } from './api.js';
import { DEFAULT_DISPLAY, type DisplayPrefs } from './format.js';
import { formatMetricValue } from './metrics.js';
import { ordinal } from './scoring.js';
import { SOLO_STATUS_LABELS } from './solo.js';

export interface WidgetChannel {
  value: number | null;
  goal: number | null;
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

export function buildWidgetSnapshot(
  today: TodayResponse,
  now: Date = new Date(),
  prefs: Display = DEFAULT_DISPLAY,
): WidgetSnapshot {
  return {
    updatedAt: now.toISOString(),
    date: today.date,
    steps: channel(today, 'steps'),
    activeCalories: channel(today, 'active_calories'),
    activeMinutes: channel(today, 'active_minutes'),
    challenge: widgetChallenge(today.featured, prefs),
  };
}
