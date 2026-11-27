/**
 * Personal records. After each sync we look at everything stored for the person, compare their
 * bests with the ones remembered in personal_records, and when one is beaten we update it, tell
 * them, and post it to the feed so friends can cheer.
 *
 * The first time a record is seen it is stored without a word, so connecting an account (which
 * pulls weeks of history) doesn't produce a pile of "new best" alerts. Day totals only count days
 * before today (they are still growing); lift records count straight away, since a set is final once
 * it is logged.
 */
import {
  addDays,
  DEFAULT_DISPLAY,
  formatQuantity,
  liftExercise,
  todayIn,
  type DisplayPrefs,
  type NotificationKind,
} from '@gauntlet/shared';
import { and, eq, inArray, like, or } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { dailyMetrics, feedEvents, personalRecords } from '../db/schema.js';
import { displayOf } from './display.js';
import { notify } from './notify.js';
import { getUser } from './users.js';

/** A day total that can set a record, with how to word it. */
const DAY_RECORDS = [
  { key: 'steps_day', metric: 'steps', label: 'step day', unit: '', decimals: 0 },
  { key: 'distance_day', metric: 'distance', label: 'distance day', unit: 'km', decimals: 1 },
  {
    key: 'active_minutes_day',
    metric: 'active_minutes',
    label: 'active-minutes day',
    unit: 'min',
    decimals: 0,
  },
  { key: 'lift_volume_day', metric: 'lift_volume', label: 'lifting day', unit: 'kg', decimals: 0 },
] as const;

export const STEP_STREAK_TARGET = 10_000;
/** A streak of one or two days isn't worth an alert. */
const MIN_STREAK_TO_ANNOUNCE = 3;
/** Never more than this many alerts from one sync. */
const MAX_ALERTS_PER_SYNC = 3;
/** Records keep moving up through a workout; announce a key at most this often. */
const QUIET_MS = 3 * 3_600_000;

export interface Candidate {
  key: string;
  value: number;
  /** Day it was set. */
  date: string;
}

interface Row {
  date: string;
  metric: string;
  value: number;
}

type Prefs = Pick<DisplayPrefs, 'units' | 'locale'>;

/** A record value in the reader's units: "12.4 km" or "7.7 mi". */
const q = (v: number, unit: string, decimals: number, prefs: Prefs) =>
  formatQuantity(v, unit, decimals, prefs);

/**
 * The short badge for a stored personal-record event, in the viewer's units. Events keep the raw
 * value and unit so each reader sees their own; events from before that kept only the text.
 */
export function recordBadge(
  payload: Record<string, unknown>,
  prefs: Prefs = DEFAULT_DISPLAY,
): string | null {
  const { value, unit, decimals } = payload;
  if (typeof value === 'number' && typeof unit === 'string' && typeof decimals === 'number')
    return q(value, unit, decimals, prefs);
  return typeof payload.badge === 'string' ? payload.badge : null;
}

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** The best value per record key in these rows (pure, so it is easy to test). */
export function bestsFrom(rows: Row[], today: string): Map<string, Candidate> {
  const best = new Map<string, Candidate>();
  const consider = (key: string, value: number, date: string) => {
    if (!(value > 0)) return;
    const cur = best.get(key);
    if (!cur || value > cur.value) best.set(key, { key, value, date });
  };
  const stepDays: string[] = [];
  for (const r of rows) {
    if (r.metric === 'steps' && r.date < today && r.value >= STEP_STREAK_TARGET)
      stepDays.push(r.date);
    const day = DAY_RECORDS.find((d) => d.metric === r.metric);
    if (day && r.date < today) consider(day.key, r.value, r.date);
    if (liftExercise(r.metric)) consider(r.metric, r.value, r.date);
  }
  // Longest run of consecutive 10k days.
  stepDays.sort();
  let run = 0;
  for (let i = 0; i < stepDays.length; i++) {
    run = i > 0 && stepDays[i] === addDays(stepDays[i - 1]!, 1) ? run + 1 : 1;
    consider('step_streak', run, stepDays[i]!);
  }
  return best;
}

interface Alert {
  text: string;
  badge: string;
  /** Raw value and unit, so every reader sees the badge in their own units. */
  value: number;
  unit: string;
  decimals: number;
  /** What the record is, e.g. "best step day". */
  label: string;
  /** Lower goes first when there are too many to announce. */
  order: number;
  key: string;
}

/** How a stored record reads in lists ("Best step day", "20,000"); null for keys we don't word. */
export function describeRecord(
  key: string,
  value: number,
  prefs: Prefs = DEFAULT_DISPLAY,
): { label: string; badge: string } | null {
  const a = describe({ key, value, date: '' }, 0, prefs);
  return a ? { label: a.label.charAt(0).toUpperCase() + a.label.slice(1), badge: a.badge } : null;
}

export function describe(
  c: Candidate,
  previous: number,
  prefs: Prefs = DEFAULT_DISPLAY,
): Alert | null {
  const day = DAY_RECORDS.find((d) => d.key === c.key);
  if (day) {
    return {
      key: c.key,
      label: `best ${day.label}`,
      order: 1,
      value: c.value,
      unit: day.unit,
      decimals: day.decimals,
      badge: q(c.value, day.unit, day.decimals, prefs),
      text: `New best ${day.label}: ${q(c.value, day.unit, day.decimals, prefs)} (was ${q(previous, day.unit, day.decimals, prefs)})`,
    };
  }
  if (c.key === 'step_streak') {
    if (c.value < MIN_STREAK_TO_ANNOUNCE) return null;
    return {
      key: c.key,
      label: 'longest 10k-step streak',
      order: 2,
      value: c.value,
      unit: 'days',
      decimals: 0,
      badge: `${c.value} days`,
      text: `New longest 10k-step streak: ${c.value} days (was ${previous})`,
    };
  }
  const lift = liftExercise(c.key);
  if (lift) {
    const name = titleCase(lift.exercise);
    const what = lift.prefix === 'lift_max:' ? 'heaviest set' : 'estimated 1RM';
    return {
      key: c.key,
      label: `${name} ${what}`,
      order: 0,
      value: c.value,
      unit: 'kg',
      decimals: 1,
      badge: q(c.value, 'kg', 1, prefs),
      text: `New ${name} ${what}: ${q(c.value, 'kg', 1, prefs)} (was ${q(previous, 'kg', 1, prefs)})`,
    };
  }
  return null;
}

/** Compare this person's bests with what we remember. Call after a sync has stored new data. */
export async function checkPersonalRecords(ctx: AppContext, userId: string): Promise<number> {
  return (await refreshPersonalRecords(ctx, userId)).alerts;
}

export interface RecordRefreshOptions {
  /**
   * Records set on a day before this one are stored without an alert or feed post. A history import
   * uses it so a record from 2022 is remembered but isn't announced as news.
   */
  quietBefore?: string;
}

/** Like checkPersonalRecords, also saying how many records were created or beaten. */
export async function refreshPersonalRecords(
  ctx: AppContext,
  userId: string,
  opts: RecordRefreshOptions = {},
): Promise<{ alerts: number; updated: number }> {
  const user = await getUser(ctx, userId);
  if (user.isDemo) return { alerts: 0, updated: 0 };
  const today = todayIn(user.timezone, ctx.now());
  const prefs = displayOf(user);

  const rows = await ctx.db
    .select({ date: dailyMetrics.date, metric: dailyMetrics.metric, value: dailyMetrics.value })
    .from(dailyMetrics)
    .where(
      and(
        eq(dailyMetrics.userId, userId),
        or(
          inArray(
            dailyMetrics.metric,
            DAY_RECORDS.map((d) => d.metric),
          ),
          eq(dailyMetrics.metric, 'steps'),
          like(dailyMetrics.metric, 'lift_max:%'),
          like(dailyMetrics.metric, 'lift_e1rm:%'),
        ),
      ),
    );
  const bests = bestsFrom(rows, today);
  if (!bests.size) return { alerts: 0, updated: 0 };

  const known = new Map(
    (await ctx.db.select().from(personalRecords).where(eq(personalRecords.userId, userId))).map(
      (r) => [r.key, r],
    ),
  );
  const alerts: Alert[] = [];
  let updated = 0;
  for (const c of bests.values()) {
    const old = known.get(c.key);
    if (old && c.value <= old.value) continue;
    await ctx.db
      .insert(personalRecords)
      .values({ userId, key: c.key, value: c.value, date: c.date, updatedAt: ctx.now() })
      .onConflictDoUpdate({
        target: [personalRecords.userId, personalRecords.key],
        set: { value: c.value, date: c.date, updatedAt: ctx.now() },
      });
    updated++;
    // First sighting is history, not news. A record that just moved is still moving.
    if (!old || ctx.now().getTime() - old.updatedAt.getTime() < QUIET_MS) continue;
    if (opts.quietBefore && c.date < opts.quietBefore) continue;
    const alert = describe(c, old.value, prefs);
    if (alert) alerts.push(alert);
  }

  alerts.sort((a, b) => a.order - b.order);
  for (const a of alerts.slice(0, MAX_ALERTS_PER_SYNC)) {
    await notify(ctx, userId, {
      kind: 'personal_record' satisfies NotificationKind,
      title: 'New personal record',
      body: a.text,
      url: '/trends',
      payload: { key: a.key },
    });
    await ctx.db.insert(feedEvents).values({
      actorId: userId,
      challengeId: null,
      kind: 'personal_record',
      payload: {
        key: a.key,
        label: a.label,
        badge: a.badge,
        value: a.value,
        unit: a.unit,
        decimals: a.decimals,
      },
    });
  }
  return { alerts: alerts.length, updated };
}
