/** The sync loop with a fake Health Connect: single flight, throttle, skipping what did not change. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TODAY = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
const mem = new Map<string, string>();
const sendRecords = vi.fn(async (_r: unknown[]) => undefined);
const sendOrigins = vi.fn(async (_o: unknown[]) => undefined);
const sendSleep = vi.fn(async (_n: unknown) => undefined);
let release: (() => void) | null = null;
let gate: Promise<void> | null = null;
const queryAggregated = vi.fn(async (_q: { dataType: string }) => {
  if (gate) await gate;
  return { samples: [{ startDate: TODAY, endDate: '', value: 100 }] };
});
const readSamples = vi.fn(async (_q: unknown) => ({ samples: [] as unknown[] }));

vi.mock('./platform', () => ({ isNative: true, timezone: 'UTC' }));
vi.mock('./storage', () => ({
  storage: {
    get: async (k: string) => mem.get(k) ?? null,
    set: async (k: string, v: string | null) => void (v == null ? mem.delete(k) : mem.set(k, v)),
  },
}));
vi.mock('./session', () => ({
  hcApps: async () => ({ order: {} }),
  sendHealthRecords: (r: unknown[]) => sendRecords(r),
  sendHealthOrigins: (o: unknown[]) => sendOrigins(o),
  sendSleepDays: (n: unknown) => sendSleep(n),
}));
vi.mock('./appLabels', () => ({ nameOrigins: async (o: unknown[]) => o }));
vi.mock('@capgo/capacitor-health', () => ({
  Health: {
    queryAggregated: (q: { dataType: string }) => queryAggregated(q),
    readSamples: (q: unknown) => readSamples(q),
    queryWorkouts: async () => ({ workouts: [] }),
    checkAuthorization: async () => ({ readAuthorized: ['sleep'] }),
  },
}));

const health = () => import('./health');

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  gate = null;
  release = null;
});

describe('syncHealthConnect', () => {
  it('runs one at a time: a second call shares the first', async () => {
    const { syncHealthConnect } = await health();
    gate = new Promise<void>((r) => (release = r));
    const a = syncHealthConnect();
    const b = syncHealthConnect();
    await new Promise((r) => setTimeout(r, 20));
    release?.();
    await Promise.all([a, b]);
    // One sync: steps, distance, calories, resting hr, heart rate and water day totals once each.
    expect(queryAggregated).toHaveBeenCalledTimes(6);
  });

  it('skips what did not change, and reads only two days when it is not time for a full read', async () => {
    const { syncHealthConnect } = await health();
    const first = await syncHealthConnect();
    expect(first).toBeGreaterThan(0);
    const again = await syncHealthConnect();
    expect(again).toBe(0);
    const mod = await health();
    expect(mod.lastSyncStats?.kind).toBe('light');
    expect(mod.lastSyncStats?.recordsSent).toBe(0);
    // The light sync's sleep read starts a day before yesterday at the earliest.
    const sleep = readSamples.mock.calls
      .map((c) => c[0] as { dataType: string; startDate: string })
      .filter((q) => q.dataType === 'sleep')
      .at(-1)!;
    const days = (Date.now() - Date.parse(sleep.startDate)) / 86_400_000;
    expect(days).toBeLessThan(3.1);
  });

  it('the resume entry skips a run right after one', async () => {
    const { syncHealthConnect, syncHealthConnectIfDue } = await health();
    await syncHealthConnect();
    expect(await syncHealthConnectIfDue()).toBeNull();
    expect(await syncHealthConnectIfDue(Date.now() + 9 * 60_000)).toBe(0);
  });

  it('sends the changed value again', async () => {
    const { syncHealthConnect } = await health();
    await syncHealthConnect();
    queryAggregated.mockImplementation(async () => ({
      samples: [{ startDate: TODAY, endDate: '', value: 250 }],
    }));
    expect(await syncHealthConnect()).toBeGreaterThan(0);
  });
});
