/**
 * Which Health Connect apps count, per stat (0.18). Several apps often write the same thing to
 * Health Connect (the phone's own step counter, Fitbit and Garmin Connect all writing steps), and
 * Health Connect's own de-duplication doesn't always catch it. A person can pick, per stat, which
 * apps the phone listens to, in order.
 *
 * Rule (applied on the phone when it reads Health Connect): for a stat with a list, each day uses
 * the FIRST listed app that has data that day, alone; apps not on the list are ignored, and a day
 * none of them covers sends nothing for that stat. A stat with no list (or an empty one) keeps
 * today's behaviour: Health Connect's own total (or, for sleep, every app's sessions with copies of
 * the same sleep removed).
 *
 * Stored per person on the server (users.hc_app_order), or on the phone in direct mode.
 */
import { z } from 'zod';
import { isHcOriginMetric } from './hcOriginMetrics.js';

/** stat key (see HC_ORIGIN_METRICS) -> Android package names, most preferred first. */
export type HcAppOrder = Record<string, string[]>;

export const hcAppOrderSchema = z
  .record(z.string(), z.array(z.string().min(1).max(200)).max(10))
  .refine((o) => Object.keys(o).every(isHcOriginMetric), 'Unknown stat')
  .refine((o) => Object.keys(o).length <= 40, 'Too many stats');

/** An app the phone has seen writing a stat recently (from health_origins). */
export interface HcAppSeen {
  packageName: string;
  /** Friendly name: from the phone when it could look it up, else healthAppName(). */
  name: string;
  /** Days in the last 30 it wrote this stat. */
  days: number;
  /** Device types seen ("watch", "phone", ...). */
  devices: string[];
}

/** GET /api/me/hc-apps; PUT takes { order: HcAppOrder } and returns the same. */
export interface HcAppsResponse {
  order: HcAppOrder;
  /** Per stat, the apps seen writing it in the last 30 days, most days first. */
  seen: Record<string, HcAppSeen[]>;
}

/** The apps that count for one stat on one day, given what each wrote (null = no filter). */
export function pickHcApp(
  order: readonly string[] | undefined,
  hasData: (packageName: string) => boolean,
): string | null | undefined {
  if (!order?.length) return undefined; // no filter: Health Connect's own total
  return order.find(hasData) ?? null; // null: none of the chosen apps had data that day
}
