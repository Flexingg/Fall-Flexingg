import type { SleepRow } from '@gauntlet/sparky';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setup, type Harness } from './notifyHarness.js';

let h: Harness;
const INGEST = '/api/ingest/health-connect';
const DAYS = `${INGEST}/sleep-days`;

const stage = (type: string, from: string, to: string) => ({
  stage_type: type,
  start_time: from,
  end_time: to,
  duration_in_seconds: (Date.parse(to) - Date.parse(from)) / 1000,
});

/** What the phone sends for a night. */
const night = (date: string, stages: ReturnType<typeof stage>[]) => ({
  type: 'SleepSession',
  entry_date: date,
  bedtime: stages[0]!.start_time,
  wake_time: stages.at(-1)!.end_time,
  duration_in_seconds:
    (Date.parse(stages.at(-1)!.end_time) - Date.parse(stages[0]!.start_time)) / 1000,
  stage_events: stages,
});

const stored = (who = 'ann') => h.sparky[who]!.sleep;
const entry = (date: string, source: string, id: string): SleepRow => ({
  id,
  entry_date: date,
  source,
  bedtime: `${date}T04:00:00.000Z`,
  wake_time: `${date}T12:00:00.000Z`,
  duration_in_seconds: 8 * 3600,
  stage_events: [stage('light', `${date}T04:00:00.000Z`, `${date}T12:00:00.000Z`)],
});

beforeAll(async () => {
  h = await setup(['ann', 'ben']);
});
afterAll(async () => h.close());

describe('rescored sleep replaces what SparkyFitness stored', () => {
  it('leaves exactly the stages the phone sent', async () => {
    const d = '2026-10-01';
    // First upload: a night plus a long nap, 9.6 h in all.
    const old = night(d, [
      stage('light', `${d}T03:00:00.000Z`, `${d}T08:00:00.000Z`),
      stage('deep', `${d}T08:00:00.000Z`, `${d}T12:36:00.000Z`),
    ]);
    await h.call('ann', 'POST', INGEST, { records: [old] });
    expect(stored()).toHaveLength(1);
    // The person rescored it: shorter, and the stages sit elsewhere.
    const next = night(d, [
      stage('light', `${d}T02:00:00.000Z`, `${d}T05:00:00.000Z`),
      stage('rem', `${d}T05:00:00.000Z`, `${d}T07:42:00.000Z`),
    ]);
    // Without the rewrite, the fake (like SparkyFitness) would keep stale stages outside the window.
    h.fake.calls.length = 0;
    await h.call('ann', 'POST', INGEST, { records: [next] });
    const row = stored()[0]!;
    expect(row.stage_events).toEqual(next.stage_events);
    expect(row.bedtime).toBe(next.bedtime);
    expect(h.fake.calls.filter((c) => c.startsWith('PUT /api/sleep/'))).toHaveLength(1);
  });

  it('writes nothing when the stored night already matches', async () => {
    const d = '2026-10-01';
    const same = night(d, stored()[0]!.stage_events as ReturnType<typeof stage>[]);
    h.fake.calls.length = 0;
    await h.call('ann', 'POST', INGEST, { records: [same] });
    expect(h.fake.calls.filter((c) => c.startsWith('PUT /api/sleep/'))).toHaveLength(0);
  });

  it('only rewrites Health Connect entries, never another source', async () => {
    const d = '2026-10-04';
    stored().push(entry(d, 'garmin', 'g-1'));
    await h.call('ann', 'POST', INGEST, {
      records: [night(d, [stage('deep', `${d}T01:00:00.000Z`, `${d}T05:00:00.000Z`)])],
    });
    const garmin = stored().find((r) => r.source === 'garmin')!;
    expect(garmin.stage_events).toEqual(entry(d, 'garmin', 'g-1').stage_events);
    const hc = stored().find((r) => r.entry_date === d && r.source === 'Health Connect')!;
    expect(hc.stage_events).toHaveLength(1);
    expect(hc.stage_events![0]!.stage_type).toBe('deep');
  });
});

describe('nights deleted in Health Connect', () => {
  it('removes nothing unless the phone says the range was read in full', async () => {
    const before = stored('ben').length;
    stored('ben').push(entry('2026-10-10', 'Health Connect', 'b-1'));
    // Ingesting records alone (no sleep-days call) never deletes.
    await h.call('ben', 'POST', INGEST, {
      records: [{ type: 'step', value: 100, date: '2026-10-10', unit: 'count' }],
    });
    expect(stored('ben')).toHaveLength(before + 1);
  });

  it('deletes Health Connect nights in the range that were not sent', async () => {
    const ben = stored('ben');
    ben.length = 0;
    ben.push(
      entry('2026-10-09', 'Health Connect', 'b-9'), // before the range: untouched
      entry('2026-10-10', 'Health Connect', 'b-10'), // sent: stays
      entry('2026-10-11', 'Health Connect', 'b-11'), // not sent: deleted
      entry('2026-10-12', 'garmin', 'b-12'), // another source: untouched
      entry('2026-10-13', 'Health Connect', 'b-13'), // after the range: untouched
      entry('2026-10-12', 'Health Connect', 'b-12h'), // not sent: deleted
    );
    const res = await h.call<{ removed: number }>('ben', 'POST', DAYS, {
      from: '2026-10-10',
      to: '2026-10-12',
      dates: ['2026-10-10'],
    });
    expect(res.removed).toBe(2);
    expect(
      stored('ben')
        .map((r) => r.id)
        .sort(),
    ).toEqual(['b-10', 'b-12', 'b-13', 'b-9']);
  });

  it('can delete every night of a range the phone found empty', async () => {
    const ben = stored('ben');
    ben.length = 0;
    ben.push(entry('2026-10-20', 'Health Connect', 'x-1'));
    await h.call('ben', 'POST', DAYS, { from: '2026-10-19', to: '2026-10-21', dates: [] });
    expect(stored('ben')).toHaveLength(0);
  });

  it('rejects ranges that are backwards, too long, or nights outside them', async () => {
    const bad = [
      { from: '2026-10-12', to: '2026-10-10', dates: [] },
      { from: '2024-01-01', to: '2026-10-10', dates: [] },
      { from: '2026-10-10', to: '2026-10-12', dates: ['2026-10-13'] },
      { from: '2026-10-10', to: '2026-10-12' },
      { from: 'soon', to: '2026-10-12', dates: [] },
    ];
    for (const body of bad) expect((await h.raw('ben', 'POST', DAYS, body)).statusCode).toBe(400);
    expect(
      (await h.raw(null, 'POST', DAYS, { from: '2026-10-10', to: '2026-10-12', dates: [] }))
        .statusCode,
    ).toBe(401);
  });

  it('keeps nights when the delete call fails part way', async () => {
    const ben = stored('ben');
    ben.length = 0;
    ben.push(entry('2026-10-30', 'Health Connect', 'k-1'));
    const spy = vi.spyOn(h.ctx.sparky, 'deleteSleep').mockRejectedValue(new Error('nope'));
    const res = await h.call<{ removed: number }>('ben', 'POST', DAYS, {
      from: '2026-10-30',
      to: '2026-10-30',
      dates: [],
    });
    spy.mockRestore();
    expect(res.removed).toBe(0);
    expect(stored('ben')).toHaveLength(1);
  });
});
