/**
 * Android only: read Health Connect and forward it to SparkyFitness through
 * the Gauntlet API. Record shapes match what the SparkyFitness mobile app
 * sends, so the two can coexist without duplicating data.
 */
import { Health, type HealthDataType } from '@capgo/capacitor-health';
import { localDate } from '@gauntlet/shared';
import { post } from './api';
import { isNative, timezone } from './platform';
import { storage } from './storage';

const READ: HealthDataType[] = ['steps', 'distance', 'calories', 'restingHeartRate', 'sleep', 'workouts'];
const LAST_SYNC_KEY = 'gauntlet.hc.lastSync';
const CHUNK = 500;

export async function healthAvailable(): Promise<{ available: boolean; reason?: string }> {
  if (!isNative) return { available: false, reason: 'Health Connect is only available in the Android app.' };
  try {
    return await Health.isAvailable();
  } catch (err) {
    return { available: false, reason: (err as Error).message };
  }
}

export async function requestHealthAccess(): Promise<boolean> {
  const status = await Health.requestAuthorization({ read: READ, write: [], requestHistoryAccess: true });
  return status.readAuthorized.includes('steps');
}

export async function openHealthSettings() {
  await Health.openHealthConnectSettings();
}

type HcRecord = Record<string, unknown> & { type: string };

const day = (iso: string) => localDate(new Date(iso), timezone);

/** Pull the last few days from Health Connect and forward them. Returns records sent. */
export async function syncHealthConnect(opts: { days?: number } = {}): Promise<number> {
  if (!isNative) return 0;
  const last = await storage.get(LAST_SYNC_KEY);
  const days = opts.days ?? (last ? 7 : 30);
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  start.setHours(0, 0, 0, 0);
  const range = { startDate: start.toISOString(), endDate: end.toISOString() };
  const records: HcRecord[] = [];
  const source = 'Health Connect';

  const daily = async (dataType: HealthDataType, aggregation: 'sum' | 'average', type: string, unit: string) => {
    try {
      const { samples } = await Health.queryAggregated({ ...range, dataType, bucket: 'day', aggregation });
      for (const s of samples) {
        if (!Number.isFinite(s.value) || s.value <= 0) continue;
        records.push({ type, value: Math.round(s.value * 100) / 100, date: day(s.startDate), unit, source });
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
      const stage = (name: string) => (s.stages ?? []).filter((x) => x.stage === name).reduce((a, x) => a + x.durationMinutes * 60, 0);
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

  for (let i = 0; i < records.length; i += CHUNK) {
    await post('/api/ingest/health-connect', { records: records.slice(i, i + CHUNK) });
  }
  await storage.set(LAST_SYNC_KEY, end.toISOString());
  return records.length;
}
