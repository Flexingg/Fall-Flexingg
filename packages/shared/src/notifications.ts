/**
 * Contract for the notification list, push setup and the weekly recap, plus the pure ISO-week and
 * recap-totals logic both the server (building the recap) and the app (linking to last week) use.
 */
import { z } from 'zod';
import { addDays } from './dates.js';
import type { AppNotification, NotificationKind } from './notify.js';

// ---------- In-app list ----------

export interface NotificationsPage {
  items: AppNotification[];
  /** Pass as `before` to load older ones; null when this was the last page. */
  nextBefore: string | null;
}

export interface NotificationPrefsResponse {
  kinds: { kind: NotificationKind; label: string; enabled: boolean }[];
}

export const notificationPrefsSchema = z.object({
  prefs: z.record(z.string(), z.boolean()),
});

// ---------- Push ----------

export interface PushConfig {
  /** null when the server operator hasn't set up web push (VAPID keys). */
  webPush: { publicKey: string } | null;
}

export const webPushSubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url().max(2000),
    keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(500) }),
  }),
  label: z.string().trim().max(60).optional(),
});
export const webPushUnsubscribeSchema = z.object({ endpoint: z.string().url().max(2000) });
export const deviceRegisterSchema = z.object({ label: z.string().trim().max(60).optional() });
export const deviceRevokeSchema = z.object({ token: z.string().min(10).max(200) });

/** What the Android app's background job receives from /api/push/device/poll. */
export interface DevicePollResponse {
  notifications: {
    id: string;
    kind: NotificationKind;
    title: string;
    body: string;
    url: string | null;
    createdAt: string;
  }[];
}

// ---------- ISO weeks (Monday to Sunday) ----------

const WEEK_RE = /^(\d{4})-W(\d{2})$/;
export const isWeekId = (s: string) => {
  const m = WEEK_RE.exec(s);
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 53;
};

/** "2026-W48" for a calendar date. */
export function isoWeekOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow + 3); // the Thursday decides the year
  const year = d.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((d.getTime() - jan1) / 86_400_000 / 7) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The Monday of an ISO week. */
export function isoWeekStart(week: string): string {
  const m = WEEK_RE.exec(week);
  if (!m) throw new Error(`Not a week: ${week}`);
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
  const mondayOfWeek1 = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86_400_000;
  return new Date(mondayOfWeek1 + (Number(m[2]) - 1) * 7 * 86_400_000).toISOString().slice(0, 10);
}

/** The ISO week before the one containing `date`. */
export const previousIsoWeek = (date: string) => isoWeekOf(addDays(date, -7));

// ---------- Weekly recap ----------

export interface RecapTotal {
  key: 'steps' | 'distance' | 'active_minutes' | 'workouts' | 'lift_volume';
  label: string;
  unit: string;
  decimals: number;
  value: number;
  /** The week before, for the comparison. */
  previous: number;
  /** Percent change vs the week before; null when there is nothing to compare with. */
  changePct: number | null;
}

export interface WeeklyRecap {
  week: string;
  start: string;
  end: string;
  /** False when nothing was recorded that week. */
  hasData: boolean;
  totals: RecapTotal[];
  bestDay: { date: string; steps: number } | null;
  /** Personal records friends were told about that week, as sentences. */
  records: string[];
  finished: { challengeId: string; name: string; rank: number; of: number }[];
  standings: { challengeId: string; name: string; rank: number; of: number }[];
}

export const RECAP_METRICS: Omit<RecapTotal, 'value' | 'previous' | 'changePct'>[] = [
  { key: 'steps', label: 'Steps', unit: '', decimals: 0 },
  { key: 'distance', label: 'Distance', unit: 'km', decimals: 1 },
  { key: 'active_minutes', label: 'Active minutes', unit: 'min', decimals: 0 },
  { key: 'workouts', label: 'Workouts', unit: '', decimals: 0 },
  { key: 'lift_volume', label: 'Volume lifted', unit: 'kg', decimals: 0 },
];

interface RecapRow {
  date: string;
  metric: string;
  value: number;
}

/** Totals for the week starting `start` and the week before it, from daily rows. */
export function buildRecapTotals(rows: RecapRow[], start: string): RecapTotal[] {
  const prevStart = addDays(start, -7);
  const end = addDays(start, 6);
  const prevEnd = addDays(start, -1);
  return RECAP_METRICS.map((m) => {
    let value = 0;
    let previous = 0;
    for (const r of rows) {
      if (r.metric !== m.key) continue;
      if (r.date >= start && r.date <= end) value += r.value;
      else if (r.date >= prevStart && r.date <= prevEnd) previous += r.value;
    }
    const round = (v: number) => Math.round(v * 100) / 100;
    return {
      ...m,
      value: round(value),
      previous: round(previous),
      changePct: previous > 0 ? Math.round(((value - previous) / previous) * 100) : null,
    };
  });
}

/** The day with the most steps in the week, or null with none. */
export function bestStepDay(
  rows: RecapRow[],
  start: string,
): { date: string; steps: number } | null {
  const end = addDays(start, 6);
  let best: { date: string; steps: number } | null = null;
  for (const r of rows) {
    if (r.metric !== 'steps' || r.date < start || r.date > end || r.value <= 0) continue;
    if (!best || r.value > best.steps) best = { date: r.date, steps: r.value };
  }
  return best;
}
