/**
 * Android only: read Health Connect and forward it to SparkyFitness through
 * the Gauntlet API. Record shapes match what the SparkyFitness mobile app
 * sends, so the two can coexist without duplicating data.
 */
import { Health, type HealthDataType } from '@capgo/capacitor-health';
import {
  addDays,
  localDate,
  planChunks,
  todayIn,
  windowDays,
  type HealthConnectProgress,
} from '@gauntlet/shared';
import { historyAccessOf, resumePoint, type HistoryAccess } from './historyPlan';
import { sendHealthRecords } from './session';
import { isNative, timezone } from './platform';
import { storage } from './storage';

const READ: HealthDataType[] = [
  'steps',
  'distance',
  'calories',
  'restingHeartRate',
  'sleep',
  'workouts',
];
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
  return status.readAuthorized.includes('steps');
}

export async function openHealthSettings() {
  await Health.openHealthConnectSettings();
}

type HcRecord = Record<string, unknown> & { type: string };

const day = (iso: string) => localDate(new Date(iso), timezone);

/** Read one time range from Health Connect as SparkyFitness-shaped records. */
async function readRange(range: { startDate: string; endDate: string }): Promise<HcRecord[]> {
  const records: HcRecord[] = [];
  const source = 'Health Connect';
  const daily = async (
    dataType: HealthDataType,
    aggregation: 'sum' | 'average',
    type: string,
    unit: string,
  ) => {
    try {
      const { samples } = await Health.queryAggregated({
        ...range,
        dataType,
        bucket: 'day',
        aggregation,
      });
      for (const s of samples) {
        if (!Number.isFinite(s.value) || s.value <= 0) continue;
        records.push({
          type,
          value: Math.round(s.value * 100) / 100,
          date: day(s.startDate),
          unit,
          source,
        });
      }
    } catch {
      /* permission not granted for this type */
    }
  };
  await daily('steps', 'sum', 'step', 'count');
  await daily('distance', 'sum', 'distance', 'm');
  await daily('calories', 'sum', 'Active Calories', 'kcal');
  await daily('restingHeartRate', 'average', 'resting_heart_rate', 'bpm');

  try {
    const { samples } = await Health.readSamples({ ...range, dataType: 'sleep', limit: 500 });
    for (const s of samples) {
      const secs = (Date.parse(s.endDate) - Date.parse(s.startDate)) / 1000;
      if (!(secs > 0)) continue;
      const stage = (name: string) =>
        (s.stages ?? [])
          .filter((x) => x.stage === name)
          .reduce((a, x) => a + x.durationMinutes * 60, 0);
      const awake = stage('awake') + stage('inBed');
      records.push({
        type: 'SleepSession',
        source,
        timestamp: s.startDate,
        entry_date: day(s.endDate),
        bedtime: s.startDate,
        wake_time: s.endDate,
        duration_in_seconds: secs,
        time_asleep_in_seconds: s.hasStageData ? Math.max(secs - awake, 0) : secs,
        deep_sleep_seconds: stage('deep'),
        light_sleep_seconds: stage('light'),
        rem_sleep_seconds: stage('rem'),
        awake_sleep_seconds: stage('awake'),
        sleep_score: 0,
      });
    }
  } catch {
    /* no sleep permission */
  }

  try {
    let anchor: string | undefined;
    do {
      const res = await Health.queryWorkouts({ ...range, limit: 100, anchor });
      for (const w of res.workouts) {
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

  return records;
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
  const days = opts.days ?? (last ? 7 : 30);
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  start.setHours(0, 0, 0, 0);
  const records = await readRange({ startDate: start.toISOString(), endDate: end.toISOString() });
  await sendAll(records);
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
    const records = await readRange({
      startDate: localMidnight(w.start).toISOString(),
      endDate: localMidnight(addDays(w.end, 1)).toISOString(),
    });
    sent += await sendAll(records);
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
