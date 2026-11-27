/**
 * The pure half of "which Health Connect app wrote this?" (0.17). Health Connect hands every sample
 * a `sourceId` (the writing app's package name) and sometimes a `deviceType`. Here those samples
 * become one HcOrigin per day and stat: each app's own value for the day (worked out with the same
 * per-day rule healthRecords.ts uses for that type, in the same unit the daily metric is stored in),
 * how many records it wrote, and which devices. `counted` is Health Connect's own de-duplicated daily
 * total where the phone read one, so two apps writing the same steps show up as values that add up to
 * more than `counted`.
 */
import type { HealthDataType } from '@capgo/capacitor-health';
import type { HcOrigin, HcOriginApp } from '@gauntlet/shared';
import {
  averageByDay,
  latestByDay,
  spreadByDay,
  sumByDay,
  type AggregatedBucket,
  type DayOf,
  type Sample,
} from './healthRecords';
import { combineSleep, type SleepSampleIn } from './sleepSessions';

/** A plugin sample with the origin fields. */
export type OriginSample = Sample & { deviceType?: string };

export type OriginSleepSample = SleepSampleIn & { sourceId?: string; deviceType?: string };

export interface OriginWorkout {
  startDate: string;
  sourceId?: string;
}

/** Records with no origin (older Health Connect data) are grouped under this name. */
const UNKNOWN_APP = 'unknown';
const good = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const MG_DL_PER_MMOL = 18.016;

type Rule = 'sum' | 'avg' | 'latest' | 'spread';

interface Spec {
  type: HealthDataType;
  rule: Rule;
  /** Which number of the sample to use (blood pressure has two). */
  pick?: (s: OriginSample) => number | undefined;
  /** Convert the day's value to the stored unit. */
  convert?: (v: number) => number;
  /** Samples that can't be real (the record mappers drop them too). */
  sampleOk?: (s: OriginSample) => boolean;
  /** A day's value that can't be real. */
  dayOk?: (v: number) => boolean;
}

/** Samples read for the origins: each Gauntlet stat, and how its day's value is worked out. */
export const ORIGIN_SPECS: Record<string, Spec> = {
  steps: { type: 'steps', rule: 'sum' },
  distance: { type: 'distance', rule: 'sum', convert: (m) => m / 1000 },
  active_calories: { type: 'calories', rule: 'sum' },
  resting_hr: { type: 'restingHeartRate', rule: 'avg' },
  water: { type: 'dietaryWater', rule: 'sum' },
  weight: { type: 'weight', rule: 'latest' },
  hr_avg: { type: 'heartRate', rule: 'avg' },
  // The day's lowest and highest reading: see HEART_EXTREME (the rule here is not used).
  hr_min: { type: 'heartRate', rule: 'avg' },
  hr_max: { type: 'heartRate', rule: 'avg' },
  hrv: { type: 'heartRateVariability', rule: 'avg' },
  respiratory_rate: { type: 'respiratoryRate', rule: 'avg' },
  spo2: { type: 'oxygenSaturation', rule: 'avg', dayOk: (v) => v <= 100 },
  vo2_max: { type: 'vo2Max', rule: 'latest' },
  bp_systolic: { type: 'bloodPressure', rule: 'avg', pick: (s) => s.systolic },
  bp_diastolic: { type: 'bloodPressure', rule: 'avg', pick: (s) => s.diastolic },
  blood_glucose: {
    type: 'bloodGlucose',
    rule: 'avg',
    convert: (v) => v / MG_DL_PER_MMOL,
  },
  body_temp: { type: 'bodyTemperature', rule: 'avg' },
  basal_body_temp: { type: 'basalBodyTemperature', rule: 'avg' },
  floors: { type: 'flightsClimbed', rule: 'sum' },
  total_calories: { type: 'totalCalories', rule: 'spread', dayOk: (v) => v < 30_000 },
  bmr: { type: 'basalCalories', rule: 'latest', dayOk: (v) => v >= 500 && v <= 10_000 },
  body_fat: { type: 'bodyFat', rule: 'latest', dayOk: (v) => v <= 100 },
  height: { type: 'height', rule: 'latest' },
  food_energy: {
    type: 'dietaryEnergyConsumed',
    rule: 'sum',
    sampleOk: (s) => good(s.value) && s.value < 20_000,
  },
  mindful_minutes: { type: 'mindfulness', rule: 'sum' },
};

/** Heart rate min/max are not an average of the day's samples. */
const HEART_EXTREME: Record<string, 'min' | 'max'> = { hr_min: 'min', hr_max: 'max' };

/**
 * How many samples one read may return. Per-minute writers (steps, heart rate) can write thousands
 * a day, so those get more room; a read that hits its cap marks its origins `capped`.
 */
export const BIG_READ_CAP = 5000;
export const ORIGIN_READ_CAP = 2000;
const BIG_TYPES = new Set<string>(['steps', 'distance', 'calories', 'heartRate']);
export const readCapOf = (type: string): number =>
  BIG_TYPES.has(type) ? BIG_READ_CAP : ORIGIN_READ_CAP;
export const SLEEP_READ_CAP = 1000;

/** The types read only to find out who wrote them (the totals come from queryAggregated). */
export const ORIGIN_ONLY_TYPES: HealthDataType[] = [
  'steps',
  'distance',
  'calories',
  'heartRate',
  'restingHeartRate',
  'dietaryWater',
];

/** Which aggregated bucket value is Health Connect's own total for each stat. */
const COUNTED_FROM: Record<
  string,
  { type: HealthDataType; pick: (b: AggregatedBucket) => number | undefined; scale?: number }
> = {
  steps: { type: 'steps', pick: (b) => b.value },
  distance: { type: 'distance', pick: (b) => b.value, scale: 1 / 1000 },
  active_calories: { type: 'calories', pick: (b) => b.value },
  resting_hr: { type: 'restingHeartRate', pick: (b) => b.value },
  water: { type: 'dietaryWater', pick: (b) => b.value },
  hr_avg: { type: 'heartRate', pick: (b) => b.values?.average },
  hr_min: { type: 'heartRate', pick: (b) => b.values?.min },
  hr_max: { type: 'heartRate', pick: (b) => b.values?.max },
};

const ruleFn = (rule: Rule) =>
  ({ sum: sumByDay, avg: averageByDay, latest: latestByDay, spread: spreadByDay })[rule];

const appOf = (s: { sourceId?: string }) => s.sourceId || UNKNOWN_APP;

function addDevice(set: Set<string>, d: string | undefined) {
  if (d) set.add(d);
}

interface Acc {
  value: number;
  records: number;
  devices: Set<string>;
}

/** Everything one read found, grouped as `metric -> date -> app -> numbers`. */
type ByDay = Map<string, Map<string, Acc>>;

function toOrigins(
  metric: string,
  byDay: ByDay,
  counted: ReadonlyMap<string, number> | undefined,
  capped: boolean,
  inRange: (date: string) => boolean,
): HcOrigin[] {
  const out: HcOrigin[] = [];
  for (const [date, apps] of byDay) {
    if (!inRange(date)) continue;
    const list: HcOriginApp[] = [...apps]
      .map(([packageName, a]) => ({
        packageName,
        value: round3(a.value),
        records: a.records,
        devices: [...a.devices].sort(),
      }))
      .sort((a, b) => b.value - a.value || a.packageName.localeCompare(b.packageName));
    if (!list.length) continue;
    out.push({ date, metric, apps: list, counted: counted?.get(date) ?? null, capped });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function countedMap(
  metric: string,
  buckets: ReadonlyMap<string, AggregatedBucket[]>,
  dayOf: DayOf,
): Map<string, number> | undefined {
  const from = COUNTED_FROM[metric];
  const list = from && buckets.get(from.type);
  if (!from || !list) return undefined;
  const out = new Map<string, number>();
  for (const b of list) {
    const v = from.pick(b);
    if (good(v)) out.set(dayOf(b.startDate), round3(v * (from.scale ?? 1)));
  }
  return out;
}

/** One stat from one type's samples: each app's day value by the stat's rule. */
export function originsOfSamples(
  metric: string,
  samples: OriginSample[],
  dayOf: DayOf,
  opts: {
    counted?: ReadonlyMap<string, number>;
    capped?: boolean;
    inRange?: (date: string) => boolean;
  } = {},
): HcOrigin[] {
  const spec = ORIGIN_SPECS[metric];
  if (!spec) return [];
  const extreme = HEART_EXTREME[metric];
  const usable = samples.filter((s) => {
    if (spec.sampleOk ? !spec.sampleOk(s) : false) return false;
    const v = (spec.pick ?? ((x: OriginSample) => x.value))(s);
    return good(v);
  });
  const sampleOf = (s: OriginSample): OriginSample =>
    spec.pick ? { ...s, value: spec.pick(s) as number } : s;

  const byApp = new Map<string, OriginSample[]>();
  for (const s of usable) {
    const k = appOf(s);
    byApp.set(k, [...(byApp.get(k) ?? []), sampleOf(s)]);
  }

  const byDay: ByDay = new Map();
  const slot = (date: string, app: string): Acc => {
    const day = byDay.get(date) ?? new Map<string, Acc>();
    byDay.set(date, day);
    const a = day.get(app) ?? { value: 0, records: 0, devices: new Set<string>() };
    day.set(app, a);
    return a;
  };
  for (const [app, list] of byApp) {
    let values: Map<string, number>;
    if (extreme) {
      values = new Map();
      for (const s of list) {
        const d = dayOf(s.startDate);
        const cur = values.get(d);
        if (cur === undefined || (extreme === 'min' ? s.value < cur : s.value > cur))
          values.set(d, s.value);
      }
    } else values = ruleFn(spec.rule)(list, dayOf);
    for (const [date, raw] of values) {
      const v = spec.convert ? spec.convert(raw) : raw;
      if (!good(v) || (spec.dayOk && !spec.dayOk(v))) continue;
      slot(date, app).value = v;
    }
    // Records and devices land on the days the value does.
    for (const s of list) {
      const days =
        spec.rule === 'spread'
          ? [...spreadByDay([s], dayOf).keys()]
          : [dayOf(spec.rule === 'latest' ? s.endDate || s.startDate : s.startDate)];
      for (const d of days) {
        const a = byDay.get(d)?.get(app);
        if (!a) continue;
        a.records++;
        addDevice(a.devices, s.deviceType);
      }
    }
  }
  return toOrigins(metric, byDay, opts.counted, opts.capped ?? false, opts.inRange ?? (() => true));
}

/** Hours asleep per app and night, each app's sessions combined like the synced night. */
export function sleepOrigins(
  samples: OriginSleepSample[],
  dayOf: DayOf,
  opts: { capped?: boolean; inRange?: (date: string) => boolean } = {},
): HcOrigin[] {
  const byApp = new Map<string, OriginSleepSample[]>();
  for (const s of samples) byApp.set(appOf(s), [...(byApp.get(appOf(s)) ?? []), s]);
  const byDay: ByDay = new Map();
  for (const [app, list] of byApp) {
    for (const n of combineSleep(list, dayOf)) {
      if (!good(n.asleepSeconds)) continue;
      const devices = new Set<string>();
      for (const s of list) if (dayOf(s.endDate) === n.date) addDevice(devices, s.deviceType);
      const day = byDay.get(n.date) ?? new Map<string, Acc>();
      byDay.set(n.date, day);
      day.set(app, { value: n.asleepSeconds / 3600, records: n.sessions, devices });
    }
  }
  return toOrigins('sleep', byDay, undefined, opts.capped ?? false, opts.inRange ?? (() => true));
}

/** Workouts counted per app and day. */
export function workoutOrigins(
  workouts: OriginWorkout[],
  dayOf: DayOf,
  opts: { inRange?: (date: string) => boolean } = {},
): HcOrigin[] {
  const byDay: ByDay = new Map();
  for (const w of workouts) {
    const date = dayOf(w.startDate);
    const day = byDay.get(date) ?? new Map<string, Acc>();
    byDay.set(date, day);
    const a = day.get(appOf(w)) ?? { value: 0, records: 0, devices: new Set<string>() };
    a.value++;
    a.records++;
    day.set(appOf(w), a);
  }
  return toOrigins('workouts', byDay, undefined, false, opts.inRange ?? (() => true));
}

export interface OriginInput {
  /** Samples each type returned (a type that failed or wasn't allowed is simply missing). */
  samples: ReadonlyMap<string, OriginSample[]>;
  /** Day buckets the phone read (Health Connect's own totals). */
  buckets: ReadonlyMap<string, AggregatedBucket[]>;
  sleep: OriginSleepSample[] | null;
  workouts: OriginWorkout[];
  dayOf: DayOf;
  /** Only days in this range are reported (the days this read is responsible for). */
  days: { from: string; to: string };
}

/** Every stat's origins from what one read found. */
export function buildOrigins(input: OriginInput): HcOrigin[] {
  const { dayOf, days } = input;
  const inRange = (d: string) => d >= days.from && d <= days.to;
  const out: HcOrigin[] = [];
  for (const [metric, spec] of Object.entries(ORIGIN_SPECS)) {
    const samples = input.samples.get(spec.type);
    if (!samples) continue;
    out.push(
      ...originsOfSamples(metric, samples, dayOf, {
        counted: countedMap(metric, input.buckets, dayOf),
        capped: samples.length >= readCapOf(spec.type),
        inRange,
      }),
    );
  }
  if (input.sleep)
    out.push(
      ...sleepOrigins(input.sleep, dayOf, {
        capped: input.sleep.length >= SLEEP_READ_CAP,
        inRange,
      }),
    );
  out.push(...workoutOrigins(input.workouts, dayOf, { inRange }));
  return out;
}
