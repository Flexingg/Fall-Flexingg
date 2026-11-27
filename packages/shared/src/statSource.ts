/**
 * "Where did this number come from?" (0.17). Every stored daily value keeps the candidates the merge
 * chose between and why it picked one (`MetricDetail`, stored in daily_metrics.detail). The phone
 * also reports, per day and stat, which Health Connect apps wrote the data it read (`HcOrigin`,
 * stored in health_origins), like the Health Connect / Fitbit app's "data sources" view. Long-press a
 * stat on the day screen (or a ring on Today) to see both: `StatSourceResponse`.
 *
 * Owner only: this is never shown for anyone else.
 */
import { z } from 'zod';

// ---------- What the merge records ----------

/**
 * Why the merge picked the value it stored:
 * - `only`: one source had it.
 * - `priority`: the person's source order (for this stat, or their default order) put it first.
 * - `highest`: several sources, the highest wins (steps and other running totals overlap, so
 *   they're never added).
 * - `preferred`: a built-in preference (e.g. a watch's resting heart rate over a phone measurement).
 * - `first`: the first value found (custom measurements).
 * - `combined`: worked out from several entries (food totals, workouts counted, lift volume).
 */
export type MergeRule = 'only' | 'priority' | 'highest' | 'preferred' | 'first' | 'combined';

export interface MetricDetail {
  rule: MergeRule;
  /** Every value a source reported for the day (raw source labels, as in daily_metrics.source). */
  candidates: { source: string | null; value: number }[];
  /** When `rule` is `priority`: whose order it was. */
  order?: 'metric' | 'default';
}

// ---------- What the phone reports ----------

/** One Health Connect app's share of a day's stat, as the phone read it. */
export interface HcOriginApp {
  /** Android package name of the app that wrote the records (Health Connect's data origin). */
  packageName: string;
  /** The app's name as Android shows it, when the phone could look it up (0.18). */
  name?: string;
  /** The day's value from this app alone, in the stat's stored unit. */
  value: number;
  /** How many Health Connect records it wrote that day. */
  records: number;
  /** Device types Health Connect reported for those records ("watch", "phone", ...). */
  devices: string[];
}

export interface HcOrigin {
  date: string;
  /** Gauntlet metric key: steps, distance, active_calories, resting_hr, sleep, water, workouts,
   * weight, or a health metric key (hr_avg, hrv, ...). */
  metric: string;
  apps: HcOriginApp[];
  /** What Health Connect itself counted for the day (its own de-duplicated total), when known. */
  counted: number | null;
  /** The phone hit its read limit, so per-app numbers may be short. */
  capped: boolean;
}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const hcOriginSchema = z.object({
  date: dateStr,
  metric: z.string().min(1).max(64),
  apps: z
    .array(
      z.object({
        packageName: z.string().min(1).max(200),
        name: z.string().max(100).optional(),
        value: z.number().finite(),
        records: z.number().int().min(0),
        devices: z.array(z.string().max(40)).max(10),
      }),
    )
    .max(30),
  counted: z.number().finite().nullable(),
  capped: z.boolean(),
});

/** POST /api/ingest/health-connect/origins */
export const hcOriginsIngestSchema = z.object({
  origins: z.array(hcOriginSchema).min(1).max(5000),
});

// ---------- What the long-press sheet shows ----------

export interface StatCandidate {
  /** Folded source key (see sourceKey in packages/sparky): garmin, health_connect, ... */
  sourceKey: string;
  /** Plain label: "Garmin", "Health Connect & phone". */
  label: string;
  value: number;
  /** This is the value that counts. */
  chosen: boolean;
}

export interface PhoneAppShare extends HcOriginApp {
  /** Friendly app name ("Fitbit", "Samsung Health"), or the package name when unknown. */
  name: string;
}

/** GET /api/me/day/stat?date=YYYY-MM-DD&metric=steps */
export interface StatSourceResponse {
  date: string;
  metric: string;
  label: string;
  /** Stored unit; the app converts for display. */
  unit: string;
  decimals: number;
  value: number | null;
  /** The source that counts, or null when there is no value. */
  source: { key: string; label: string } | null;
  rule: MergeRule | null;
  order?: 'metric' | 'default';
  /** All sources that reported a value, the chosen one first. Empty when only the value is known
   * (stored before 0.17). */
  candidates: StatCandidate[];
  /** What the phone saw in Health Connect for this day and stat; null when it reported nothing. */
  phone: {
    apps: PhoneAppShare[];
    counted: number | null;
    capped: boolean;
    /** When the phone last sent this. */
    reportedAt: string;
  } | null;
  /** Two or more Health Connect apps wrote this stat that day: possibly the same activity twice. */
  overlap: boolean;
  /** When Gauntlet last stored this value. */
  updatedAt: string | null;
}

/** Common Health Connect writers, so the sheet can say "Fitbit" instead of a package name. */
export const KNOWN_HEALTH_APPS: Record<string, string> = {
  'com.google.android.apps.fitness': 'Google Fit',
  'com.google.android.apps.healthdata': 'Health Connect',
  'com.google.android.healthconnect.controller': 'Health Connect',
  'com.fitbit.FitbitMobile': 'Fitbit',
  'com.sec.android.app.shealth': 'Samsung Health',
  'com.garmin.android.apps.connectmobile': 'Garmin Connect',
  'com.ouraring.oura': 'Oura',
  'com.withings.wiscale2': 'Withings',
  'com.strava': 'Strava',
  'com.whoop.android': 'WHOOP',
  'com.polar.polarflow': 'Polar Flow',
  'com.xiaomi.wearable': 'Mi Fitness',
  'com.mi.health': 'Mi Fitness',
  'com.huawei.health': 'Huawei Health',
  'com.coros.coros': 'COROS',
  'com.suunto.android': 'Suunto',
  'com.myfitnesspal.android': 'MyFitnessPal',
  'com.zepp.android': 'Zepp',
  'com.amazfit.android': 'Zepp',
  'com.google.android.wearable.healthservices': 'Wear OS',
  'com.samsung.android.wear.shealth': 'Samsung Health (watch)',
  'com.sparkyfitness.mobile': 'SparkyFitness',
  'cc.randalls.gauntlet': 'Gauntlet',
  'com.urbandroid.sleep': 'Sleep as Android',
};

/** The phone's own sensors (its step counter) write under a package like this plus a hash. */
const PHONE_PACKAGE_PREFIX = 'com.android.healthconnect.phone';

/**
 * A friendly name for a Health Connect app: our own wording for the ones we know, else the name
 * Android gave the phone (`phoneName`, from HcOriginApp.name), else the package name.
 */
export function healthAppName(packageName: string, phoneName?: string): string {
  if (packageName.startsWith(PHONE_PACKAGE_PREFIX)) return 'This phone';
  return KNOWN_HEALTH_APPS[packageName] ?? (phoneName?.trim() || packageName);
}
