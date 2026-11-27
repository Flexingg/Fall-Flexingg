/**
 * The pure half of the Health Connect reader: which data types we ask for (grouped in plain words
 * for the permission screen), how long a sync looks back, and how raw Health Connect samples become
 * the records SparkyFitness takes. Kept apart from the plugin so it can be unit tested.
 *
 * Why one value per day: SparkyFitness stores types it has no special handling for as "custom
 * measurements" with Daily frequency, so a second value for the same day replaces the first. Sending
 * one per day (the same value every re-send, since a sync re-sends the last week) can't pile up
 * duplicates. The few types that are not one-a-day (water, food) carry a stable `source_id`, which
 * SparkyFitness uses to update in place.
 */
import type { HealthDataType } from '@capgo/capacitor-health';

// ------------------------------------------------------------- what we ask for

export interface AccessGroup {
  title: string;
  items: { type: HealthDataType; label: string }[];
}

/**
 * Everything the Health Connect plugin can read on Android, in plain words. Apple-only types
 * (stand hours, wrist temperature, exercise minutes) don't exist in Health Connect, and cycling
 * distance is the same permission as distance, so neither is listed.
 */
export const ACCESS_GROUPS: AccessGroup[] = [
  {
    title: 'Activity',
    items: [
      { type: 'steps', label: 'Steps' },
      { type: 'distance', label: 'Distance' },
      { type: 'flightsClimbed', label: 'Floors climbed' },
      { type: 'calories', label: 'Active calories' },
      { type: 'totalCalories', label: 'Total calories burned' },
      { type: 'basalCalories', label: 'Resting calories' },
      { type: 'workouts', label: 'Workouts' },
    ],
  },
  {
    title: 'Body',
    items: [
      { type: 'weight', label: 'Weight' },
      { type: 'bodyFat', label: 'Body fat' },
      { type: 'height', label: 'Height' },
    ],
  },
  {
    title: 'Heart and vitals',
    items: [
      { type: 'heartRate', label: 'Heart rate' },
      { type: 'restingHeartRate', label: 'Resting heart rate' },
      { type: 'heartRateVariability', label: 'Heart rate variability' },
      { type: 'respiratoryRate', label: 'Breathing rate' },
      { type: 'oxygenSaturation', label: 'Blood oxygen' },
      { type: 'vo2Max', label: 'VO2 max' },
      { type: 'bloodPressure', label: 'Blood pressure' },
      { type: 'bloodGlucose', label: 'Blood sugar' },
      { type: 'bodyTemperature', label: 'Body temperature' },
      { type: 'basalBodyTemperature', label: 'Basal body temperature' },
    ],
  },
  { title: 'Sleep', items: [{ type: 'sleep', label: 'Sleep' }] },
  {
    title: 'Nutrition',
    items: [
      { type: 'dietaryWater', label: 'Water' },
      { type: 'dietaryEnergyConsumed', label: 'Food calories' },
    ],
  },
  { title: 'Mind', items: [{ type: 'mindfulness', label: 'Mindfulness' }] },
];

/** Every type we request read access for. */
export const READ_TYPES: HealthDataType[] = ACCESS_GROUPS.flatMap((g) =>
  g.items.map((i) => i.type),
);

/** The permission Gauntlet needs at minimum before it turns syncing on. */
export const CORE_TYPE: HealthDataType = 'steps';

export interface AccessRow {
  type: HealthDataType;
  label: string;
  allowed: boolean;
}

/** The groups with each type marked allowed or not, given what Health Connect says is allowed. */
export function accessRows(allowed: readonly string[]): { title: string; rows: AccessRow[] }[] {
  const ok = new Set(allowed);
  return ACCESS_GROUPS.map((g) => ({
    title: g.title,
    rows: g.items.map((i) => ({ ...i, allowed: ok.has(i.type) })),
  }));
}

/** "12 of 22 allowed" style summary. */
export function accessSummary(allowed: readonly string[]): { allowed: number; total: number } {
  const ok = new Set(allowed);
  return { allowed: READ_TYPES.filter((t) => ok.has(t)).length, total: READ_TYPES.length };
}

// --------------------------------------------------------------- sync window

/** The first sync reaches back this many days (Health Connect shows 30 days without extra access). */
export const FIRST_SYNC_DAYS = 30;
/**
 * Later syncs re-send the last week (plus today): data logged late (a watch syncing a day later) and
 * a night's sleep totals that were still changing land by overwriting, not by being missed.
 */
export const RESEND_DAYS = 7;

/** How many whole days before today a sync starts from. */
export function syncDays(hasSyncedBefore: boolean, override?: number): number {
  return override ?? (hasSyncedBefore ? RESEND_DAYS : FIRST_SYNC_DAYS);
}

/** Local midnight `days` days before `now`. */
export function syncStart(now: Date, days: number): Date {
  const start = new Date(now);
  start.setDate(start.getDate() - days);
  start.setHours(0, 0, 0, 0);
  return start;
}

// ------------------------------------------------------------ record mapping

export type HcRecord = Record<string, unknown> & { type: string };

/** The bits of a plugin sample the mappers use. */
export interface Sample {
  value: number;
  startDate: string;
  endDate: string;
  platformId?: string;
  sourceId?: string;
  systolic?: number;
  diastolic?: number;
}

/** A day bucket from `queryAggregated`. */
export interface AggregatedBucket {
  startDate: string;
  value: number;
  values?: Partial<Record<'sum' | 'average' | 'min' | 'max', number>>;
}

/** ISO instant to the person's local day (YYYY-MM-DD). */
export type DayOf = (iso: string) => string;

const SOURCE = 'Health Connect';
const round2 = (n: number) => Math.round(n * 100) / 100;
const good = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Most samples one type may send in one read (Health Connect can hold thousands a day). */
export const SAMPLE_CAP = 2000;

function daily(type: string, unit: string, byDay: Map<string, number>): HcRecord[] {
  return [...byDay]
    .filter(([, v]) => good(v))
    .map(([date, v]) => ({ type, value: round2(v), date, unit, source: SOURCE }));
}

/** Add each sample's value to its day. */
export function sumByDay(samples: Sample[], dayOf: DayOf): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of samples)
    if (good(s.value)) {
      const d = dayOf(s.startDate);
      out.set(d, (out.get(d) ?? 0) + s.value);
    }
  return out;
}

/** The average of each day's samples. */
export function averageByDay(
  samples: Sample[],
  dayOf: DayOf,
  pick: (s: Sample) => number | undefined = (s) => s.value,
): Map<string, number> {
  const acc = new Map<string, { sum: number; n: number }>();
  for (const s of samples) {
    const v = pick(s);
    if (!good(v)) continue;
    const d = dayOf(s.startDate);
    const a = acc.get(d) ?? { sum: 0, n: 0 };
    a.sum += v;
    a.n++;
    acc.set(d, a);
  }
  return new Map([...acc].map(([d, a]) => [d, a.sum / a.n]));
}

/** The last reading of each day (by end time). */
export function latestByDay(
  samples: Sample[],
  dayOf: DayOf,
  pick: (s: Sample) => number | undefined = (s) => s.value,
): Map<string, number> {
  const best = new Map<string, { at: string; v: number }>();
  for (const s of samples) {
    const v = pick(s);
    if (!good(v)) continue;
    const d = dayOf(s.endDate || s.startDate);
    const cur = best.get(d);
    if (!cur || s.endDate >= cur.at) best.set(d, { at: s.endDate, v });
  }
  return new Map([...best].map(([d, b]) => [d, b.v]));
}

/**
 * Add each sample's value to the days it covers, in proportion to the time spent in each day: an
 * energy total recorded across midnight (or a whole day at once) is split, not lumped on one day.
 */
export function spreadByDay(
  samples: Sample[],
  dayOf: DayOf,
  stepMs = 30 * 60_000,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of samples) {
    if (!good(s.value)) continue;
    const a = Date.parse(s.startDate);
    const b = Date.parse(s.endDate);
    if (!Number.isFinite(a)) continue;
    if (!Number.isFinite(b) || b - a <= stepMs) {
      const d = dayOf(s.startDate);
      out.set(d, (out.get(d) ?? 0) + s.value);
      continue;
    }
    const steps = Math.ceil((b - a) / stepMs);
    for (let i = 0; i < steps; i++) {
      const from = a + i * stepMs;
      const to = Math.min(b, from + stepMs);
      const d = dayOf(new Date((from + to) / 2).toISOString());
      out.set(d, (out.get(d) ?? 0) + (s.value * (to - from)) / (b - a));
    }
  }
  return out;
}

// SparkyFitness' own names and units for each type (its mobile app uses the same).

/** Total calories burned (everything, not just exercise), one per day. */
export const totalCaloriesRecords = (samples: Sample[], dayOf: DayOf): HcRecord[] =>
  daily('TotalCaloriesBurned', 'kcal', spreadByDay(samples, dayOf)).filter(
    (r) => (r.value as number) < 30_000,
  );

/** Resting (basal) energy: Health Connect gives a rate in kcal a day; the latest each day. */
export const basalRecords = (samples: Sample[], dayOf: DayOf): HcRecord[] =>
  daily('BasalMetabolicRate', 'kcal', latestByDay(samples, dayOf)).filter(
    (r) => (r.value as number) >= 500 && (r.value as number) <= 10_000,
  );

export const weightRecords = (samples: Sample[], dayOf: DayOf): HcRecord[] =>
  daily('weight', 'kg', latestByDay(samples, dayOf));

export const bodyFatRecords = (samples: Sample[], dayOf: DayOf): HcRecord[] =>
  daily('body_fat', '%', latestByDay(samples, dayOf)).filter((r) => (r.value as number) <= 100);

/** Height arrives in centimetres; SparkyFitness reads the unit. */
export const heightRecords = (samples: Sample[], dayOf: DayOf): HcRecord[] =>
  daily('height', 'cm', latestByDay(samples, dayOf));

/**
 * Water: a day's total in millilitres (Health Connect says litres). The id is the same each
 * re-send, so SparkyFitness updates that day's entry instead of adding another.
 */
export function waterRecords(buckets: AggregatedBucket[], dayOf: DayOf): HcRecord[] {
  return buckets
    .filter((b) => good(b.value))
    .map((b) => {
      const date = dayOf(b.startDate);
      return {
        type: 'water',
        value: Math.round(b.value * 1000),
        date,
        unit: 'ml',
        source: SOURCE,
        source_id: `gauntlet-water-${date}`,
        timestamp: b.startDate,
      };
    });
}

/**
 * Food energy from Health Connect as a day's total (a daily measurement, not food diary entries):
 * people who log food in SparkyFitness would otherwise count the same meals twice.
 */
export const nutritionRecords = (samples: Sample[], dayOf: DayOf): HcRecord[] =>
  daily(
    'dietary_energy',
    'kcal',
    sumByDay(
      samples.filter((x) => good(x.value) && x.value < 20_000),
      dayOf,
    ),
  );

/** Heart rate as the day's lowest, highest and average (min/max/avg is what SparkyFitness keeps). */
export function heartRateRecords(buckets: AggregatedBucket[], dayOf: DayOf): HcRecord[] {
  const out: HcRecord[] = [];
  for (const b of buckets) {
    const date = dayOf(b.startDate);
    const v = b.values ?? {};
    for (const [key, name] of [
      ['min', 'heart_rate_min'],
      ['max', 'heart_rate_max'],
      ['average', 'heart_rate_avg'],
    ] as const) {
      const n = v[key];
      if (good(n)) out.push({ type: name, value: round2(n), date, unit: 'bpm', source: SOURCE });
    }
  }
  return out;
}

export const restingHeartRateRecords = (buckets: AggregatedBucket[], dayOf: DayOf): HcRecord[] =>
  buckets
    .filter((b) => good(b.value))
    .map((b) => ({
      type: 'resting_heart_rate',
      value: round2(b.value),
      date: dayOf(b.startDate),
      unit: 'bpm',
      source: SOURCE,
    }));

export const hrvRecords = (samples: Sample[], dayOf: DayOf): HcRecord[] =>
  daily('HRV', 'ms', averageByDay(samples, dayOf));

export const respiratoryRateRecords = (samples: Sample[], dayOf: DayOf): HcRecord[] =>
  daily('respiratory_rate', 'breaths/min', averageByDay(samples, dayOf));

export const oxygenRecords = (samples: Sample[], dayOf: DayOf): HcRecord[] =>
  daily('oxygen_saturation', '%', averageByDay(samples, dayOf)).filter(
    (r) => (r.value as number) <= 100,
  );

export const vo2MaxRecords = (samples: Sample[], dayOf: DayOf): HcRecord[] =>
  daily('vo2_max', 'ml/min/kg', latestByDay(samples, dayOf));

/** The day's average reading, systolic and diastolic as two numbers. */
export const bloodPressureRecords = (samples: Sample[], dayOf: DayOf): HcRecord[] => [
  ...daily(
    'blood_pressure_systolic',
    'mmHg',
    averageByDay(samples, dayOf, (s) => s.systolic),
  ),
  ...daily(
    'blood_pressure_diastolic',
    'mmHg',
    averageByDay(samples, dayOf, (s) => s.diastolic),
  ),
];

/** Health Connect gives mg/dL; SparkyFitness shows mmol/L. */
export const MG_DL_PER_MMOL = 18.016;
export const bloodGlucoseRecords = (samples: Sample[], dayOf: DayOf): HcRecord[] =>
  daily(
    'blood_glucose',
    'mmol/L',
    new Map(
      [...averageByDay(samples, dayOf)].map(
        ([d, v]) => [d, v / MG_DL_PER_MMOL] as [string, number],
      ),
    ),
  );

export const bodyTemperatureRecords = (samples: Sample[], dayOf: DayOf): HcRecord[] =>
  daily('body_temperature', 'celsius', averageByDay(samples, dayOf));

export const basalBodyTemperatureRecords = (samples: Sample[], dayOf: DayOf): HcRecord[] =>
  daily('basal_body_temperature', 'celsius', averageByDay(samples, dayOf));

export const floorsRecords = (samples: Sample[], dayOf: DayOf): HcRecord[] =>
  daily('floors_climbed', 'count', sumByDay(samples, dayOf));

/** Minutes of mindfulness sessions in the day. */
export const mindfulnessRecords = (samples: Sample[], dayOf: DayOf): HcRecord[] =>
  daily('mindfulness_minutes', 'min', sumByDay(samples, dayOf));
