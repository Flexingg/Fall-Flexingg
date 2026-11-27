/**
 * The pure half of "only count the Health Connect apps I picked" (0.18; the rule is in
 * packages/shared/src/hcApps.ts: per stat and day, the first listed app that has data, alone).
 *
 * Health Connect's own daily totals can't be limited to one app, so for a stat with a list the
 * phone replaces the total with the chosen app's own value for the day, taken from the per-app
 * origins it already works out (hcOriginsRead.ts, in each stat's stored unit) and turned back into
 * the record SparkyFitness takes. Sleep and workouts are lists of sessions, so there the sessions
 * of the chosen app are kept. A day none of the listed apps covers sends nothing for that stat.
 */
import {
  isHcOriginMetric,
  pickHcApp,
  type HcAppOrder,
  type HcOrigin,
  type HcOriginApp,
} from '@gauntlet/shared';
import type { HcRecord, Sample } from './healthRecords';
import { ORIGIN_SPECS } from './hcOriginsRead';

const SOURCE = 'Health Connect';
const round2 = (n: number) => Math.round(n * 100) / 100;

interface RecordSpec {
  /** SparkyFitness record type (what healthRecords.ts sends for the stat). */
  type: string;
  unit: string;
  /** Stored unit to the record's unit (origins have distance in km, water in litres). */
  scale?: number;
}

/** Every stat whose day total the phone can rebuild from one app's samples. */
export const APP_RECORDS: Record<string, RecordSpec> = {
  steps: { type: 'step', unit: 'count' },
  distance: { type: 'distance', unit: 'm', scale: 1000 },
  active_calories: { type: 'Active Calories', unit: 'kcal' },
  resting_hr: { type: 'resting_heart_rate', unit: 'bpm' },
  water: { type: 'water', unit: 'ml', scale: 1000 },
  weight: { type: 'weight', unit: 'kg' },
  hr_avg: { type: 'heart_rate_avg', unit: 'bpm' },
  hr_min: { type: 'heart_rate_min', unit: 'bpm' },
  hr_max: { type: 'heart_rate_max', unit: 'bpm' },
  hrv: { type: 'HRV', unit: 'ms' },
  respiratory_rate: { type: 'respiratory_rate', unit: 'breaths/min' },
  spo2: { type: 'oxygen_saturation', unit: '%' },
  vo2_max: { type: 'vo2_max', unit: 'ml/min/kg' },
  bp_systolic: { type: 'blood_pressure_systolic', unit: 'mmHg' },
  bp_diastolic: { type: 'blood_pressure_diastolic', unit: 'mmHg' },
  blood_glucose: { type: 'blood_glucose', unit: 'mmol/L' },
  body_temp: { type: 'body_temperature', unit: 'celsius' },
  basal_body_temp: { type: 'basal_body_temperature', unit: 'celsius' },
  floors: { type: 'floors_climbed', unit: 'count' },
  total_calories: { type: 'TotalCaloriesBurned', unit: 'kcal' },
  bmr: { type: 'BasalMetabolicRate', unit: 'kcal' },
  body_fat: { type: 'body_fat', unit: '%' },
  height: { type: 'height', unit: 'cm' },
  food_energy: { type: 'dietary_energy', unit: 'kcal' },
  mindful_minutes: { type: 'mindfulness_minutes', unit: 'min' },
};

/** The stats with a non-empty app list (others, and unknown keys, mean "no filter"). */
export function activeOrder(order: HcAppOrder | null | undefined): HcAppOrder {
  const out: HcAppOrder = {};
  for (const [metric, apps] of Object.entries(order ?? {}))
    if (isHcOriginMetric(metric) && Array.isArray(apps) && apps.length) out[metric] = apps;
  return out;
}

/** Health Connect data types that must be read in small windows so per-app values aren't cut off. */
export function filteredSampleTypes(order: HcAppOrder): Set<string> {
  const out = new Set<string>();
  for (const metric of Object.keys(activeOrder(order))) {
    const spec = ORIGIN_SPECS[metric];
    if (spec) out.add(spec.type);
  }
  return out;
}

/** Record types whose Health Connect total is replaced by the chosen apps' values. */
export function replacedRecordTypes(order: HcAppOrder): Set<string> {
  const out = new Set<string>();
  for (const metric of Object.keys(activeOrder(order))) {
    const spec = APP_RECORDS[metric];
    if (spec) out.add(spec.type);
  }
  return out;
}

/**
 * The records for the stats with a list: each day's value from the first listed app that has one.
 * `midnightOf` gives the local midnight of a date (water entries carry a time).
 */
export function recordsFromOrigins(
  order: HcAppOrder,
  origins: HcOrigin[],
  midnightOf: (date: string) => string,
): HcRecord[] {
  const active = activeOrder(order);
  const out: HcRecord[] = [];
  for (const o of origins) {
    const list = active[o.metric];
    const spec = APP_RECORDS[o.metric];
    if (!list || !spec) continue;
    const has = (pkg: string) => o.apps.some((a) => a.packageName === pkg && a.value > 0);
    const picked = pickHcApp(list, has);
    const app: HcOriginApp | undefined = o.apps.find((a) => a.packageName === picked);
    if (!app) continue;
    const rec: HcRecord = {
      type: spec.type,
      value: round2(app.value * (spec.scale ?? 1)),
      date: o.date,
      unit: spec.unit,
      source: SOURCE,
    };
    if (o.metric === 'water') {
      // Like waterRecords(): whole millilitres, one entry a day that a re-send updates in place.
      rec.value = Math.round(app.value * 1000);
      rec.source_id = `gauntlet-water-${o.date}`;
      rec.timestamp = midnightOf(o.date);
    }
    out.push(rec);
  }
  return out;
}

/**
 * Keep only the chosen app's items for each day (sleep sessions, workouts). `list` empty or missing
 * means no filter. A day none of the listed apps has anything for loses all its items.
 */
export function keepChosenApp<T>(
  items: T[],
  list: readonly string[] | undefined,
  dayOf: (item: T) => string,
  appOf: (item: T) => string,
): T[] {
  if (!list?.length) return items;
  const appsByDay = new Map<string, Set<string>>();
  for (const it of items) {
    const d = dayOf(it);
    appsByDay.set(d, (appsByDay.get(d) ?? new Set()).add(appOf(it)));
  }
  const pick = new Map<string, string | null | undefined>();
  for (const [d, apps] of appsByDay)
    pick.set(
      d,
      pickHcApp(list, (a) => apps.has(a)),
    );
  return items.filter((it) => pick.get(dayOf(it)) === appOf(it));
}

// ------------------------------------------------------------------ reading in windows

export interface Window {
  startDate: string;
  endDate: string;
}

/** [start, end) cut at each local midnight. */
export function dayWindows(startIso: string, endIso: string): Window[] {
  const out: Window[] = [];
  const end = new Date(endIso).getTime();
  let cur = new Date(startIso);
  while (cur.getTime() < end) {
    const next = new Date(cur);
    next.setHours(24, 0, 0, 0); // the next local midnight (DST safe)
    const stop = Math.min(next.getTime(), end);
    out.push({ startDate: cur.toISOString(), endDate: new Date(stop).toISOString() });
    cur = new Date(stop);
  }
  return out;
}

/** Windows shorter than this aren't split further, even when a read hits its cap. */
const MIN_SPLIT_MS = 2 * 3600_000;

/**
 * Read each window; a window that comes back full (the plugin returns the newest `cap` samples, so
 * the rest would be missing) is split in halves and read again. Samples that show up in both halves
 * (one that spans the cut) are kept once.
 */
export async function readInWindows<T extends Sample>(
  read: (w: Window) => Promise<T[]>,
  windows: Window[],
  cap: number,
): Promise<T[]> {
  const out = new Map<string, T>();
  const add = (list: T[]) => {
    for (const s of list) {
      out.set(s.platformId ?? `${s.startDate}|${s.endDate}|${s.value}|${s.sourceId}`, s);
    }
  };
  const go = async (w: Window, depth: number): Promise<void> => {
    const got = await read(w);
    const a = Date.parse(w.startDate);
    const b = Date.parse(w.endDate);
    if (got.length >= cap && b - a > MIN_SPLIT_MS && depth < 6) {
      const mid = new Date(a + (b - a) / 2).toISOString();
      await go({ startDate: w.startDate, endDate: mid }, depth + 1);
      await go({ startDate: mid, endDate: w.endDate }, depth + 1);
      return;
    }
    add(got);
  };
  for (const w of windows) await go(w, 0);
  return [...out.values()];
}
