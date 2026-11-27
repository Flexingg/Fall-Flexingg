/**
 * Android only: read Health Connect and forward it to SparkyFitness through
 * the Gauntlet API. Record shapes match what the SparkyFitness mobile app
 * sends, so the two can coexist without duplicating data.
 */
import { Health, type HealthDataType } from '@capgo/capacitor-health';
import {
  addDays,
  type HcOrigin,
  localDate,
  planChunks,
  todayIn,
  windowDays,
  type HealthConnectProgress,
} from '@gauntlet/shared';
import { historyAccessOf, resumePoint, type HistoryAccess } from './historyPlan';
import {
  basalBodyTemperatureRecords,
  basalRecords,
  bloodGlucoseRecords,
  bloodPressureRecords,
  bodyFatRecords,
  bodyTemperatureRecords,
  CORE_TYPE,
  floorsRecords,
  heartRateRecords,
  heightRecords,
  hrvRecords,
  mindfulnessRecords,
  nutritionRecords,
  oxygenRecords,
  READ_TYPES,
  respiratoryRateRecords,
  restingHeartRateRecords,
  syncDays,
  syncStart,
  totalCaloriesRecords,
  vo2MaxRecords,
  waterRecords,
  weightRecords,
  type AggregatedBucket,
  type HcRecord,
} from './healthRecords';
import {
  buildOrigins,
  ORIGIN_ONLY_TYPES,
  readCapOf,
  SLEEP_READ_CAP,
  type OriginSample,
  type OriginSleepSample,
  type OriginWorkout,
} from './hcOriginsRead';
import { combineSleep } from './sleepSessions';
import { sendHealthOrigins, sendHealthRecords } from './session';
import { isNative, timezone } from './platform';
import { storage } from './storage';

const READ = READ_TYPES;
const LAST_SYNC_KEY = 'gauntlet.hc.lastSync';
const CHUNK = 500;

export async function healthAvailable(): Promise<{ available: boolean; reason?: string }> {
  if (!isNative)
    return { available: false, reason: 'Health Connect is only available in the Android app.' };
  try {
    return await Health.isAvailable();
  } catch (err) {
    return { available: false, reason: (err as Error).message };
  }
}

export async function requestHealthAccess(): Promise<boolean> {
  const status = await Health.requestAuthorization({
    read: READ,
    write: [],
    requestHistoryAccess: true,
  });
  return status.readAuthorized.includes(CORE_TYPE);
}

/** Which of the types we read are currently allowed in Health Connect (null when it can't say). */
export async function healthAllowed(): Promise<string[] | null> {
  if (!isNative) return null;
  try {
    const s = await Health.checkAuthorization({ read: READ, write: [] });
    return s.readAuthorized;
  } catch {
    return null;
  }
}

/** Ask for every type again. Returns what is allowed afterwards. */
export async function askHealthAccessAgain(): Promise<string[] | null> {
  try {
    const s = await Health.requestAuthorization({
      read: READ,
      write: [],
      requestHistoryAccess: true,
    });
    return s.readAuthorized;
  } catch {
    return null;
  }
}

export async function openHealthSettings() {
  await Health.openHealthConnectSettings();
}

const day = (iso: string) => localDate(new Date(iso), timezone);

/** Read one time range from Health Connect as SparkyFitness-shaped records. */
async function readRange(
  range: { startDate: string; endDate: string },
  /** Local days (inclusive) whose sleep this read sends: each night is sent whole, once. */
  sleepDays: { from: string; to: string },
): Promise<{ records: HcRecord[]; origins: HcOrigin[] }> {
  const records: HcRecord[] = [];
  const source = 'Health Connect';
  /** Run one type's read; a type that isn't allowed (or fails) just adds nothing. */
  const attempt = async (read: () => Promise<HcRecord[]>) => {
    try {
      records.push(...(await read()));
    } catch {
      /* permission not granted for this type */
    }
  };
  // Each type is read once: the record mappers and the origins (which app wrote it) share it.
  const sampleReads = new Map<string, OriginSample[]>();
  const samples = async (dataType: HealthDataType): Promise<OriginSample[]> => {
    const have = sampleReads.get(dataType);
    if (have) return have;
    const got = (await Health.readSamples({ ...range, dataType, limit: readCapOf(dataType) }))
      .samples;
    sampleReads.set(dataType, got);
    return got;
  };
  /** Health Connect's own day totals, kept so origins can say what it counted. */
  const bucketReads = new Map<string, AggregatedBucket[]>();
  const buckets = async (
    dataType: HealthDataType,
    aggregation: 'sum' | 'average' | 'min' | 'max' | ('average' | 'min' | 'max')[],
  ): Promise<AggregatedBucket[]> => {
    const got = (await Health.queryAggregated({ ...range, dataType, bucket: 'day', aggregation }))
      .samples;
    bucketReads.set(dataType, got);
    return got;
  };
  const daily = (
    dataType: HealthDataType,
    aggregation: 'sum' | 'average',
    type: string,
    unit: string,
  ) =>
    attempt(async () =>
      (await buckets(dataType, aggregation))
        .filter((s) => Number.isFinite(s.value) && s.value > 0)
        .map((s) => ({
          type,
          value: Math.round(s.value * 100) / 100,
          date: day(s.startDate),
          unit,
          source,
        })),
    );
  await daily('steps', 'sum', 'step', 'count');
  await daily('distance', 'sum', 'distance', 'm');
  await daily('calories', 'sum', 'Active Calories', 'kcal');
  await attempt(async () =>
    restingHeartRateRecords(await buckets('restingHeartRate', 'average'), day),
  );
  await attempt(async () =>
    heartRateRecords(await buckets('heartRate', ['min', 'max', 'average']), day),
  );
  await attempt(async () => waterRecords(await buckets('dietaryWater', 'sum'), day));
  await attempt(async () => totalCaloriesRecords(await samples('totalCalories'), day));
  await attempt(async () => basalRecords(await samples('basalCalories'), day));
  await attempt(async () => floorsRecords(await samples('flightsClimbed'), day));
  await attempt(async () => nutritionRecords(await samples('dietaryEnergyConsumed'), day));
  await attempt(async () => weightRecords(await samples('weight'), day));
  await attempt(async () => bodyFatRecords(await samples('bodyFat'), day));
  await attempt(async () => heightRecords(await samples('height'), day));
  await attempt(async () => hrvRecords(await samples('heartRateVariability'), day));
  await attempt(async () => respiratoryRateRecords(await samples('respiratoryRate'), day));
  await attempt(async () => oxygenRecords(await samples('oxygenSaturation'), day));
  await attempt(async () => vo2MaxRecords(await samples('vo2Max'), day));
  await attempt(async () => bloodPressureRecords(await samples('bloodPressure'), day));
  await attempt(async () => bloodGlucoseRecords(await samples('bloodGlucose'), day));
  await attempt(async () => bodyTemperatureRecords(await samples('bodyTemperature'), day));
  await attempt(async () =>
    basalBodyTemperatureRecords(await samples('basalBodyTemperature'), day),
  );
  await attempt(async () => mindfulnessRecords(await samples('mindfulness'), day));

  // Types that only have day totals above are read again as samples, just to learn who wrote them.
  // A few reads (one per type, one after another); one that fails only means no origins for it.
  for (const type of ORIGIN_ONLY_TYPES) {
    try {
      await samples(type);
    } catch {
      /* not allowed, or Health Connect is rate limiting: no origins for this type */
    }
  }

  // Sleep: one entry per night (SparkyFitness keeps one per day and source, so separate sessions
  // would overwrite each other). Read from a day early so a night that started the evening before
  // the range is whole, and only send the days this range is responsible for.
  let sleepRead: OriginSleepSample[] | null = null;
  try {
    const from = new Date(Date.parse(range.startDate) - 86_400_000).toISOString();
    const { samples } = await Health.readSamples({
      startDate: from,
      endDate: range.endDate,
      dataType: 'sleep',
      limit: SLEEP_READ_CAP,
    });
    sleepRead = samples;
    for (const n of combineSleep(samples, day)) {
      if (n.date < sleepDays.from || n.date > sleepDays.to) continue;
      records.push({
        type: 'SleepSession',
        source,
        timestamp: n.bedtime,
        entry_date: n.date,
        bedtime: n.bedtime,
        wake_time: n.wakeTime,
        duration_in_seconds: n.inBedSeconds,
        time_asleep_in_seconds: n.asleepSeconds,
        deep_sleep_seconds: n.deepSeconds,
        light_sleep_seconds: n.lightSeconds,
        rem_sleep_seconds: n.remSeconds,
        awake_sleep_seconds: n.awakeSeconds,
        sleep_score: 0,
      });
    }
  } catch {
    /* no sleep permission */
  }

  const workoutsRead: OriginWorkout[] = [];
  try {
    let anchor: string | undefined;
    do {
      const res = await Health.queryWorkouts({ ...range, limit: 100, anchor });
      for (const w of res.workouts) {
        workoutsRead.push({ startDate: w.startDate, sourceId: w.sourceId });
        const date = day(w.startDate);
        records.push({
          type: 'ExerciseSession',
          source,
          source_id: w.platformId ?? `${w.sourceId ?? 'hc'}-${w.startDate}`,
          date,
          entry_date: date,
          timestamp: w.startDate,
          startTime: w.startDate,
          endTime: w.endDate,
          duration: w.duration,
          activityType: w.workoutType,
          title: w.workoutType.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()),
          caloriesBurned: Math.round((w.totalEnergyBurned ?? 0) * 100) / 100,
          distance: Math.round(((w.totalDistance ?? 0) / 1000) * 100) / 100,
        });
      }
      anchor = res.anchor;
    } while (anchor);
  } catch {
    /* no workout permission */
  }

  let origins: HcOrigin[] = [];
  try {
    origins = buildOrigins({
      samples: sampleReads,
      buckets: bucketReads,
      sleep: sleepRead,
      workouts: workoutsRead,
      dayOf: day,
      days: sleepDays,
    });
  } catch {
    /* origins are extra: never let them break the sync */
  }
  return { records, origins };
}

/** Send origins (extra information: a failure here never fails the sync). */
async function sendOrigins(origins: HcOrigin[]): Promise<void> {
  if (!origins.length) return;
  try {
    await sendHealthOrigins(origins);
  } catch {
    /* an older server without the endpoint, or offline: the next sync sends them again */
  }
}

/** Send records in batches. Returns how many went. */
async function sendAll(records: HcRecord[]): Promise<number> {
  for (let i = 0; i < records.length; i += CHUNK) {
    await sendHealthRecords(records.slice(i, i + CHUNK));
  }
  return records.length;
}

/** Pull the last few days from Health Connect and forward them. Returns records sent. */
export async function syncHealthConnect(opts: { days?: number } = {}): Promise<number> {
  if (!isNative) return 0;
  const last = await storage.get(LAST_SYNC_KEY);
  const end = new Date();
  // Re-sends the last week every time (see RESEND_DAYS), so late data and sleep totals overwrite.
  const start = syncStart(end, syncDays(!!last, opts.days));
  const { records, origins } = await readRange(
    { startDate: start.toISOString(), endDate: end.toISOString() },
    { from: day(start.toISOString()), to: day(end.toISOString()) },
  );
  await sendAll(records);
  await sendOrigins(origins);
  await storage.set(LAST_SYNC_KEY, end.toISOString());
  return records.length;
}

// ---------------------------------------------------------------- history

const HISTORY_KEY = 'gauntlet.hc.history';
/** Days per Health Connect read: a few types each, so small windows stay quick and reliable. */
export const HC_HISTORY_CHUNK_DAYS = 14;
/** Health Connect keeps 30 days readable until the person allows past data. */
const HC_DEFAULT_WINDOW_DAYS = 30;
/** Stop after this many empty windows in a row (about three months with nothing). */
const RAN_DRY_AFTER = 6;

export async function healthHistoryAccess(): Promise<HistoryAccess> {
  if (!isNative) return 'unsupported';
  try {
    const s = await Health.checkAuthorization({
      read: READ,
      write: [],
      requestHistoryAccess: true,
    });
    return historyAccessOf(s);
  } catch {
    return 'unknown';
  }
}

/** Ask again, this time showing Health Connect's permission sheet. */
export async function requestHealthHistoryAccess(): Promise<HistoryAccess> {
  try {
    return historyAccessOf(
      await Health.requestAuthorization({ read: READ, write: [], requestHistoryAccess: true }),
    );
  } catch {
    return 'unknown';
  }
}

export interface HealthHistoryProgress {
  doneDays: number;
  totalDays: number;
  records: number;
  /** Oldest day sent so far. */
  oldest: string;
}

export interface HealthHistoryResult {
  records: number;
  /** Oldest day with data that was sent, or null when nothing was found. */
  oldestWithData: string | null;
  /**
   * `done`: reached the date asked for. `cancelled`. `ran_dry`: months of nothing in a row, so
   * there is probably nothing older (or Health Connect isn't allowed to show it).
   */
  reason: 'done' | 'cancelled' | 'ran_dry';
  access: HistoryAccess;
}

async function savedProgress(): Promise<HealthConnectProgress | null> {
  try {
    const raw = await storage.get(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as HealthConnectProgress) : null;
  } catch {
    return null;
  }
}

/** Is there an import that stopped part way (so "Continue" makes sense)? */
export async function pendingHealthHistory(): Promise<HealthConnectProgress | null> {
  return savedProgress();
}

const localMidnight = (date: string) => new Date(`${date}T00:00:00`);

/**
 * Read Health Connect back `days` days in small windows, newest first, forwarding each window's
 * records in batches. It remembers the oldest day done, so an import that was interrupted (app
 * closed, phone locked) carries on from there next time, and `signal` cancels between windows.
 * Without "past data" access Health Connect returns nothing older than 30 days, which shows up here
 * as empty windows: the import stops instead of grinding through years of nothing, and says why.
 */
export async function importHealthConnectHistory(
  days: number,
  onProgress: (p: HealthHistoryProgress) => void = () => {},
  signal?: AbortSignal,
): Promise<HealthHistoryResult> {
  const access = await healthHistoryAccess();
  if (!isNative) return { records: 0, oldestWithData: null, reason: 'done', access };
  const today = todayIn(timezone);
  const target = addDays(today, -days);
  const total = days + 1;
  const saved = await savedProgress();
  const resumeFrom = resumePoint(saved, target, today);
  const first = resumeFrom ?? today;
  let sent = 0;
  let oldest: string | null = null;
  let emptyRun = 0;
  let reason: HealthHistoryResult['reason'] = 'done';
  let doneDays = resumeFrom ? daysSpan(resumeFrom, today) : 0;

  for (const w of planChunks(target, first, HC_HISTORY_CHUNK_DAYS)) {
    if (signal?.aborted) {
      reason = 'cancelled';
      break;
    }
    const { records, origins } = await readRange(
      {
        startDate: localMidnight(w.start).toISOString(),
        endDate: localMidnight(addDays(w.end, 1)).toISOString(),
      },
      { from: w.start, to: w.end },
    );
    sent += await sendAll(records);
    await sendOrigins(origins);
    doneDays += windowDays(w);
    if (records.length) {
      oldest = records.map((r) => String(r.date ?? r.entry_date ?? w.start)).sort()[0]!;
      emptyRun = 0;
    } else emptyRun++;
    // Save where we got to, so a closed app resumes here.
    await storage.set(
      HISTORY_KEY,
      JSON.stringify({ oldestDone: w.start, target } satisfies HealthConnectProgress),
    );
    onProgress({
      doneDays: Math.min(doneDays, total),
      totalDays: total,
      records: sent,
      oldest: w.start,
    });
    // Past the first 30 days: months of nothing in a row means there is nothing older to find.
    if (w.start < addDays(today, -HC_DEFAULT_WINDOW_DAYS) && emptyRun >= RAN_DRY_AFTER) {
      reason = 'ran_dry';
      break;
    }
  }
  if (reason !== 'cancelled') await storage.set(HISTORY_KEY, null);
  return { records: sent, oldestWithData: oldest, reason, access };
}

const daysSpan = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
