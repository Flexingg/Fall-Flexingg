/**
 * Android only: read Health Connect and forward it to SparkyFitness through
 * the Gauntlet API. Record shapes match what the SparkyFitness mobile app
 * sends, so the two can coexist without duplicating data.
 */
import { Health, type HealthDataType, type Workout } from '@capgo/capacitor-health';
import {
  addDays,
  type HcOrigin,
  type SleepDaysBody,
  localDate,
  planChunks,
  type HcAppOrder,
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
import { nameOrigins } from './appLabels';
import {
  activeOrder,
  dayWindows,
  filteredSampleTypes,
  keepChosenApp,
  readInWindows,
  recordsFromOrigins,
  replacedRecordTypes,
} from './hcAppFilter';
import { combineSleep } from './sleepSessions';
import { hcApps, sendHealthOrigins, sendHealthRecords, sendSleepDays } from './session';
import { sleepDaysNote } from './sleepDaysNote';
import { nextState, planSync, resumeDue, type PlanState } from './hcSyncPlan';
import {
  changedItems,
  originKey,
  parseSent,
  recordKey,
  remember,
  type Pending,
  type SentMap,
} from './hcSent';
import { createYielder } from './yieldToUi';
import { isNative, timezone } from './platform';
import { storage } from './storage';

const READ = READ_TYPES;
const LAST_SYNC_KEY = 'gauntlet.hc.lastSync';
const PLAN_KEY = 'gauntlet.hc.plan';
const SENT_KEY = 'gauntlet.hc.sent';
const CHUNK = 500;
/** Fingerprints of days older than this many days are forgotten (a full sync reaches back 7). */
const KEEP_SENT_DAYS = 14;

/** What the last sync cost, for the dev console: bridge reads and samples that crossed it. */
export interface HcSyncStats {
  kind: string;
  aggregated: number;
  sampleReads: number;
  samples: number;
  workoutPages: number;
  records: number;
  recordsSent: number;
  origins: number;
  originsSent: number;
  ms: number;
}
let stats: Omit<
  HcSyncStats,
  'kind' | 'records' | 'recordsSent' | 'origins' | 'originsSent' | 'ms'
> = { aggregated: 0, sampleReads: 0, samples: 0, workoutPages: 0 };
export let lastSyncStats: HcSyncStats | null = null;
/** Lets the screen paint between heavy steps (replaced for each sync). */
let pause = createYielder();

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
  /** Which apps count per stat (see hcAppFilter.ts); `{}` is Health Connect's own totals. */
  appOrder: HcAppOrder = {},
  /**
   * From when the samples read only to learn who wrote a stat (steps, heart rate...) are read, when
   * that is later than `range.startDate` (see hcSyncPlan.ts). A stat with a chosen app is always
   * read for the whole range: its value is made from them.
   */
  originsFrom?: string,
): Promise<{ records: HcRecord[]; origins: HcOrigin[]; sleepNote: SleepDaysBody | null }> {
  const order = activeOrder(appOrder);
  // Stats with a chosen app are read a day at a time, so a busy day can't push another app's
  // samples out of the plugin's newest-N window.
  const perDay = filteredSampleTypes(order);
  const records: HcRecord[] = [];
  const source = 'Health Connect';
  /** Run one type's read; a type that isn't allowed (or fails) just adds nothing. */
  const attempt = async (read: () => Promise<HcRecord[]>) => {
    try {
      records.push(...(await read()));
    } catch {
      /* permission not granted for this type */
    }
    await pause();
  };
  // Each type is read once: the record mappers and the origins (which app wrote it) share it.
  const sampleReads = new Map<string, OriginSample[]>();
  const samples = async (dataType: HealthDataType): Promise<OriginSample[]> => {
    const have = sampleReads.get(dataType);
    if (have) return have;
    const limit = readCapOf(dataType);
    const read = async (w: { startDate: string; endDate: string }) => {
      const got = (await Health.readSamples({ ...w, dataType, limit })).samples;
      stats.sampleReads++;
      stats.samples += got.length;
      return got;
    };
    const narrow = originsFrom && !perDay.has(dataType) && ORIGIN_ONLY_TYPES.includes(dataType);
    const window = narrow ? { ...range, startDate: originsFrom } : range;
    const got = perDay.has(dataType)
      ? await readInWindows(read, dayWindows(range.startDate, range.endDate), limit)
      : await read(window);
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
    stats.aggregated++;
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
    await pause();
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
    stats.sampleReads++;
    stats.samples += samples.length;
    // Only the chosen app's sessions (if the person picked one), then the usual one entry a night.
    const counted = keepChosenApp(
      samples,
      order.sleep,
      (x) => day(x.endDate),
      (x) => x.sourceId || 'unknown',
    );
    for (const n of combineSleep(counted, day)) {
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
        // SparkyFitness works the night out from these, not from the totals above: sending the real
        // stages every time makes each upload replace what an earlier, partial one left behind.
        stage_events: n.stageEvents,
      });
    }
  } catch {
    /* no sleep permission */
  }

  const workoutsRead: OriginWorkout[] = [];
  try {
    const found: { w: Workout; date: string }[] = [];
    let anchor: string | undefined;
    do {
      const res = await Health.queryWorkouts({ ...range, limit: 100, anchor });
      stats.workoutPages++;
      for (const w of res.workouts) {
        workoutsRead.push({ startDate: w.startDate, sourceId: w.sourceId });
        found.push({ w, date: day(w.startDate) });
      }
      anchor = res.anchor;
    } while (anchor);
    for (const { w, date } of keepChosenApp(
      found,
      order.workouts,
      (x) => x.date,
      (x) => x.w.sourceId || 'unknown',
    )) {
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

  // Stats with a chosen app: swap Health Connect's day total for that app's own value (made from
  // the origins above, which always cover every app so the settings screen can list them all).
  let sent = records;
  try {
    if (Object.keys(order).length) {
      const gone = replacedRecordTypes(order);
      const own = recordsFromOrigins(order, origins, (d) => localMidnight(d).toISOString());
      sent = [...records.filter((r) => !gone.has(r.type)), ...own];
    }
  } catch {
    /* a filter that can't be applied leaves Health Connect's own totals */
  }
  // The nights this read holds, for the server to drop any it no longer has (null: not read in full).
  const sleepNote = sleepDaysNote({
    read: sleepRead,
    cap: SLEEP_READ_CAP,
    sleepAllowed: sleepRead && !sleepRead.length ? await sleepAllowed() : null,
    range: sleepDays,
    records: sent,
  });
  return { records: sent, origins: await nameOrigins(origins), sleepNote };
}

/** Is sleep access granted (null when Health Connect can't say)? */
async function sleepAllowed(): Promise<boolean | null> {
  try {
    return (
      await Health.checkAuthorization({ read: ['sleep'], write: [] })
    ).readAuthorized.includes('sleep');
  } catch {
    return null;
  }
}

/** Send the nights a fully read range holds (extra: a failure never fails the sync). */
async function sendSleepNote(note: SleepDaysBody | null): Promise<void> {
  if (!note) return;
  try {
    await sendSleepDays(note);
  } catch {
    /* an older server without the endpoint, or offline: the next sync sends it again */
  }
}

/** Send origins (extra information: a failure here never fails the sync). Returns the ones taken. */
async function sendOrigins(origins: HcOrigin[]): Promise<boolean> {
  if (!origins.length) return true;
  try {
    await sendHealthOrigins(origins);
    return true;
  } catch {
    /* an older server without the endpoint, or offline: the next sync sends them again */
    return false;
  }
}

/** Send records in batches, letting the screen paint between them. Returns how many went. */
async function sendAll(records: HcRecord[], onSent?: (n: number) => void): Promise<number> {
  for (let i = 0; i < records.length; i += CHUNK) {
    await sendHealthRecords(records.slice(i, i + CHUNK));
    onSent?.(Math.min(i + CHUNK, records.length));
    await pause();
  }
  return records.length;
}

async function loadPlanState(): Promise<PlanState> {
  try {
    const raw = await storage.get(PLAN_KEY);
    return raw ? (JSON.parse(raw) as PlanState) : {};
  } catch {
    return {};
  }
}

/** One at a time: a resume and the Sync now button (or two resumes) share the run that is going. */
let inflight: Promise<number> | null = null;

/**
 * Pull recent days from Health Connect and forward them. Returns records sent. What is read and what
 * is sent depends on how long ago the last full read was (hcSyncPlan.ts); `days` forces a full range.
 */
export function syncHealthConnect(opts: { days?: number } = {}): Promise<number> {
  if (!isNative) return Promise.resolve(0);
  inflight ??= runSync(opts).finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Coming back to the app: sync unless one finished in the last few minutes (or is running).
 * Resolves to the records sent, or null when it was skipped.
 */
export async function syncHealthConnectIfDue(now = Date.now()): Promise<number | null> {
  if (!isNative || inflight) return null;
  const last = Date.parse((await storage.get(LAST_SYNC_KEY)) ?? '');
  if (!resumeDue(now, Number.isFinite(last) ? last : null)) return null;
  return syncHealthConnect();
}

async function runSync(opts: { days?: number }): Promise<number> {
  const t0 = Date.now();
  pause = createYielder();
  stats = { aggregated: 0, sampleReads: 0, samples: 0, workoutPages: 0 };
  const stored = await loadPlanState();
  // Updated from a version without a plan but synced before: a normal full week, not a first sync.
  const state: PlanState =
    stored.lastFull == null && (await storage.get(LAST_SYNC_KEY)) ? { lastFull: 0 } : stored;
  const plan = planSync({ now: t0, state, days: opts.days });
  const end = new Date();
  const start = syncStart(end, syncDays(true, plan.days));
  // The old resend-everything rule is now this plan; late data is picked up by the next full read.
  const recent = plan.originsFull ? undefined : syncStart(end, 1).toISOString();
  const { records, origins, sleepNote } = await readRange(
    { startDate: start.toISOString(), endDate: end.toISOString() },
    { from: day(start.toISOString()), to: day(end.toISOString()) },
    (await hcApps()).order,
    recent,
  );
  const sent: SentMap = parseSent(await storage.get(SENT_KEY));
  const keepFrom = addDays(todayIn(timezone), -KEEP_SENT_DAYS);
  const recs = changedItems(records, recordKey, sent, plan.sendAll);
  const origs = changedItems(origins, originKey, sent, plan.sendAll);
  const done: Pending<unknown>[] = [];
  try {
    await sendAll(
      recs.map((p) => p.item),
      (n) => done.push(...recs.slice(done.length, n)),
    );
    // Sleep nights are named from every record read, not only the ones that changed.
    await sendSleepNote(sleepNote);
    if (await sendOrigins(origs.map((p) => p.item))) done.push(...origs);
  } finally {
    // Remember what the server took, even when a later batch failed.
    await storage.set(SENT_KEY, JSON.stringify(remember(sent, done, keepFrom)));
  }
  await storage.set(PLAN_KEY, JSON.stringify(nextState(state, plan, t0)));
  await storage.set(LAST_SYNC_KEY, end.toISOString());
  lastSyncStats = {
    kind: plan.kind,
    ...stats,
    records: records.length,
    recordsSent: recs.length,
    origins: origins.length,
    originsSent: origs.length,
    ms: Date.now() - t0,
  };
  if (import.meta.env.DEV && import.meta.env.MODE !== 'test')
    console.debug('[health connect sync]', lastSyncStats);
  return recs.length;
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
  const appOrder = (await hcApps()).order;
  pause = createYielder();

  for (const w of planChunks(target, first, HC_HISTORY_CHUNK_DAYS)) {
    if (signal?.aborted) {
      reason = 'cancelled';
      break;
    }
    const { records, origins, sleepNote } = await readRange(
      {
        startDate: localMidnight(w.start).toISOString(),
        endDate: localMidnight(addDays(w.end, 1)).toISOString(),
      },
      { from: w.start, to: w.end },
      appOrder,
    );
    sent += await sendAll(records);
    await sendSleepNote(sleepNote);
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
