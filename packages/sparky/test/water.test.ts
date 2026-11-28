import { describe, expect, it } from 'vitest';
import { SparkyClient } from '../src/client.js';
import { FakeSparky } from '../src/fakeSparky.js';
import { fetchMerged } from '../src/fetchMerged.js';
import { mergeDailyDetailed, type MergeInput } from '../src/merge.js';

const empty: MergeInput = {
  start: '2026-10-01',
  end: '2026-10-03',
  daily: [],
  checkIns: [],
  custom: {},
  exerciseDays: [],
  exerciseEntries: [],
  sleep: [],
  customMetrics: {},
};
const get = (r: ReturnType<typeof mergeDailyDetailed>, date: string, metric: string) =>
  r.values.find((v) => v.date === date && v.metric === metric);
const OZ = 29.5735; // ml

describe('water per source', () => {
  const both: MergeInput['water'] = [
    { entry_date: '2026-10-01', water_ml: 80 * OZ, source: 'manual' },
    { entry_date: '2026-10-01', water_ml: 80 * OZ, source: 'Health Connect' },
  ];

  it('picks one source a day instead of adding them (no more doubled water)', () => {
    const r = mergeDailyDetailed({ ...empty, water: both });
    const w = get(r, '2026-10-01', 'water')!;
    expect(w.value).toBeCloseTo((80 * OZ) / 1000, 3);
    expect(w.detail?.rule).toBe('highest');
    expect(w.detail?.candidates.map((c) => c.source).sort()).toEqual(['Health Connect', 'manual']);
  });

  it('takes the higher source by default', () => {
    const r = mergeDailyDetailed({
      ...empty,
      water: [
        { entry_date: '2026-10-01', water_ml: 500, source: 'manual' },
        { entry_date: '2026-10-01', water_ml: 1800, source: 'Health Connect' },
      ],
    });
    expect(get(r, '2026-10-01', 'water')).toMatchObject({ value: 1.8, source: 'Health Connect' });
  });

  it('adds several drinks of one source', () => {
    const r = mergeDailyDetailed({
      ...empty,
      water: [
        { entry_date: '2026-10-01', water_ml: 500, source: 'manual' },
        { entry_date: '2026-10-01', water_ml: 750, source: 'manual' },
      ],
    });
    expect(get(r, '2026-10-01', 'water')).toMatchObject({ value: 1.25 });
    expect(get(r, '2026-10-01', 'water')?.detail?.rule).toBe('combined');
  });

  it('follows the order the person chose, by source key', () => {
    const water: MergeInput['water'] = [
      { entry_date: '2026-10-01', water_ml: 500, source: 'manual' },
      { entry_date: '2026-10-01', water_ml: 1800, source: 'Health Connect' },
    ];
    const mine = mergeDailyDetailed({ ...empty, water, priorities: { water: ['sparkyfitness'] } });
    expect(get(mine, '2026-10-01', 'water')).toMatchObject({ value: 0.5, source: 'manual' });
    expect(get(mine, '2026-10-01', 'water')?.detail?.rule).toBe('priority');
    // The default order applies to water like it does to steps.
    const dflt = mergeDailyDetailed({ ...empty, water, priorities: { '*': ['sparkyfitness'] } });
    expect(get(dflt, '2026-10-01', 'water')?.value).toBe(0.5);
  });

  it('computes % of goal from the source that counted', () => {
    const water: MergeInput['water'] = [
      { entry_date: '2026-10-01', water_ml: 1000, source: 'manual' },
      { entry_date: '2026-10-01', water_ml: 1000, source: 'Health Connect' },
    ];
    const r = mergeDailyDetailed({
      ...empty,
      water,
      goals: { '2026-10-01': { water_goal_ml: 2500 } },
    });
    // Not 80% (both added): 1 L of a 2.5 L goal.
    expect(get(r, '2026-10-01', 'water_goal')?.value).toBe(40);
    const mine = mergeDailyDetailed({
      ...empty,
      water: [water![0]!, { ...water![1]!, water_ml: 3000 }],
      goals: { '2026-10-01': { water_goal_ml: 2500 } },
      priorities: { water: ['sparkyfitness'] },
    });
    expect(get(mine, '2026-10-01', 'water_goal')?.value).toBe(40);
    const capped = mergeDailyDetailed({
      ...empty,
      water: [{ entry_date: '2026-10-01', water_ml: 4000 }],
      goals: { '2026-10-01': { water_goal_ml: 2000 } },
    });
    expect(get(capped, '2026-10-01', 'water_goal')?.value).toBe(100);
  });

  it('lists water among the stats with several sources seen', () => {
    expect(mergeDailyDetailed({ ...empty, water: both }).sources.water).toEqual([
      'health_connect',
      'sparkyfitness',
    ]);
  });
});

describe('fetchMerged splits water by source', () => {
  function setup() {
    const fake = new FakeSparky();
    const user = fake.addUser({ id: 'u', email: 'u@x.test', password: 'p', name: 'U' });
    user.goals.push({ from: '2026-01-01', goals: { water_goal_ml: 2500 } });
    user.water.push(
      { entry_date: '2026-10-01', water_ml: 2365.88, source: 'manual' },
      { entry_date: '2026-10-01', water_ml: 2365.88, source: 'Health Connect' },
      { entry_date: '2026-10-02', water_ml: 1000, source: 'manual' },
    );
    const client = new SparkyClient({ baseUrl: fake.baseUrl, fetch: fake.fetch });
    return { fake, client, token: fake.mintKey('u') };
  }

  it('reads each day once and counts the drink a single time', async () => {
    const { fake, client, token } = setup();
    const r = await fetchMerged(client, token, '2026-10-01', '2026-10-03', {
      water: {},
      goals: {},
    });
    const w = r.merged.find((v) => v.date === '2026-10-01' && v.metric === 'water')!;
    expect(w.value).toBeCloseTo(2.366, 3);
    expect(w.detail?.candidates.map((c) => c.source).sort()).toEqual(['Health Connect', 'manual']);
    expect(r.merged.find((v) => v.date === '2026-10-02' && v.metric === 'water')).toMatchObject({
      value: 1,
      source: 'manual',
    });
    expect(fake.calls.filter((c) => c.includes('/water-intake/'))).toHaveLength(2);
  });

  it('reuses a known split and falls back to the total when a day was not looked up', async () => {
    const { fake, client, token } = setup();
    const known = {
      '2026-10-01': [
        { entry_date: '2026-10-01', water_ml: 2365.88, source: 'manual' },
        { entry_date: '2026-10-01', water_ml: 2365.88, source: 'Health Connect' },
      ],
    };
    const r = await fetchMerged(client, token, '2026-10-01', '2026-10-03', {
      water: { known, maxFetches: 0 },
    });
    expect(fake.calls.filter((c) => c.includes('/water-intake/'))).toHaveLength(0);
    const day1 = r.merged.find((v) => v.date === '2026-10-01' && v.metric === 'water')!;
    expect(day1.value).toBeCloseTo(2.366, 3);
    // Day 2 wasn't looked up: its total stands on its own.
    expect(
      r.merged.find((v) => v.date === '2026-10-02' && v.metric === 'water')?.detail?.candidates,
    ).toEqual([{ source: 'water', value: 1 }]);
  });

  it('ignores a known split that no longer adds up to the total', async () => {
    const { fake, client, token } = setup();
    const stale = {
      '2026-10-02': [{ entry_date: '2026-10-02', water_ml: 400, source: 'manual' }],
    };
    const r = await fetchMerged(client, token, '2026-10-01', '2026-10-03', {
      water: { known: stale },
    });
    expect(r.merged.find((v) => v.date === '2026-10-02' && v.metric === 'water')?.value).toBe(1);
    expect(fake.calls.filter((c) => c.endsWith('/water-intake/2026-10-02'))).toHaveLength(1);
  });
});
