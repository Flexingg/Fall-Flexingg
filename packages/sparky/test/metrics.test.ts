import { describe, expect, it } from 'vitest';
import { SparkyClient } from '../src/client.js';
import { FakeSparky } from '../src/fakeSparky.js';
import { fetchEvents, fetchMerged } from '../src/fetchMerged.js';
import { buildEvents, mergeDaily, type MergeInput } from '../src/merge.js';

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
const val = (rows: ReturnType<typeof mergeDaily>, date: string, metric: string) =>
  rows.find((r) => r.date === date && r.metric === metric)?.value;

describe('nutrition and goals', () => {
  it('scores a bulker and a cutter on their own targets', () => {
    const bulker = mergeDaily({
      ...empty,
      nutrition: [{ date: '2026-10-01', calories: 3200, protein: 200, carbs: 380, fat: 90 }],
      goals: { '2026-10-01': { calories: 3200, protein: 200, carbs: 380, fat: 90 } },
    });
    const cutter = mergeDaily({
      ...empty,
      nutrition: [{ date: '2026-10-01', calories: '1980', protein: 160, carbs: 150, fat: 60 }],
      goals: { '2026-10-01': { calories: 1800, protein: 160, carbs: 150, fat: 60 } },
    });
    expect(val(bulker, '2026-10-01', 'calorie_adherence')).toBe(100);
    expect(val(bulker, '2026-10-01', 'macro_adherence')).toBe(100);
    expect(val(cutter, '2026-10-01', 'calorie_adherence')).toBe(80); // 10% over
    expect(val(cutter, '2026-10-01', 'calories_in')).toBe(1980);
    expect(val(cutter, '2026-10-01', 'goal_calories')).toBe(1800);
  });

  it('counts water on days without food, against the water goal', () => {
    const rows = mergeDaily({
      ...empty,
      water: [
        { entry_date: '2026-10-02', water_ml: 1500 },
        { entry_date: '2026-10-03', water_ml: 4000 },
      ],
      goals: {
        '2026-10-02': { water_goal_ml: 2000 },
        '2026-10-03': { water_goal_ml: 2000 },
      },
    });
    expect(val(rows, '2026-10-02', 'water')).toBe(1.5);
    expect(val(rows, '2026-10-02', 'water_goal')).toBe(75);
    expect(val(rows, '2026-10-03', 'water_goal')).toBe(100); // capped
    // Nothing eaten, so no food adherence that day.
    expect(val(rows, '2026-10-02', 'calorie_adherence')).toBeUndefined();
  });

  it('keeps weigh-ins (server-side only) from check-ins', () => {
    const rows = mergeDaily({
      ...empty,
      checkIns: [
        { entry_date: '2026-10-01', weight: 82.4, updated_at: '2026-10-01T07:00:00Z' },
        { entry_date: '2026-10-01', weight: 82.1, updated_at: '2026-10-01T21:00:00Z' },
      ],
    });
    expect(val(rows, '2026-10-01', 'weight')).toBe(82.1);
  });
});

describe('strength', () => {
  const entries: MergeInput['exerciseEntries'] = [
    {
      entry_date: '2026-10-01',
      exercise_name: 'Squat',
      exercise_source: 'liftosaur',
      sets: [
        { set_type: 'Warm-up', reps: 5, weight: 60 },
        { set_type: 'Working Set', reps: 5, weight: 100 },
        { set_type: 'Working Set', reps: '3', weight: '110' },
      ],
    },
    {
      entry_date: '2026-10-01',
      exercise_name: 'Pull Up',
      sets: [{ reps: 8, weight: 0 }],
    },
  ];

  it('adds up volume and working sets, ignoring warm-ups', () => {
    const rows = mergeDaily({ ...empty, exerciseEntries: entries });
    expect(val(rows, '2026-10-01', 'lift_volume')).toBe(500 + 330);
    expect(val(rows, '2026-10-01', 'lift_sets')).toBe(3);
    // Per-exercise values only for exercises someone competes on.
    expect(val(rows, '2026-10-01', 'lift_max:squat')).toBeUndefined();
  });

  it('records the heaviest set and best estimated 1RM per wanted exercise', () => {
    const rows = mergeDaily({ ...empty, exerciseEntries: entries, lifts: ['squat'] });
    expect(val(rows, '2026-10-01', 'lift_max:squat')).toBe(110);
    expect(val(rows, '2026-10-01', 'lift_e1rm:squat')).toBe(121); // 110 × (1 + 3/30)
  });
});

describe('fasting', () => {
  it('credits finished fasts to the day they end, in the person’s time zone', () => {
    const rows = mergeDaily({
      ...empty,
      timezone: 'America/Los_Angeles',
      fasts: [
        {
          id: 'a',
          start_time: '2026-10-01T03:00:00Z',
          end_time: '2026-10-01T20:00:00Z',
          target_end_time: '2026-10-01T19:00:00Z',
          duration_minutes: 1020,
          status: 'COMPLETED',
        },
        {
          id: 'b', // ended early
          start_time: '2026-10-02T03:00:00Z',
          end_time: '2026-10-02T13:00:00Z',
          target_end_time: '2026-10-02T19:00:00Z',
          status: 'COMPLETED',
        },
        { id: 'c', start_time: '2026-10-03T03:00:00Z', status: 'ACTIVE' },
      ],
    });
    expect(val(rows, '2026-10-01', 'fast_hours')).toBe(17);
    expect(val(rows, '2026-10-01', 'fasts_completed')).toBe(1);
    expect(val(rows, '2026-10-02', 'fast_hours')).toBe(10);
    expect(val(rows, '2026-10-02', 'fasts_completed')).toBeUndefined();
    expect(val(rows, '2026-10-03', 'fast_hours')).toBeUndefined();
  });
});

describe('fetchMerged', () => {
  function setup() {
    const fake = new FakeSparky();
    const user = fake.addUser({ id: 'u', email: 'u@x.test', password: 'p', name: 'U' });
    user.nutrition.push(
      { date: '2026-10-01', calories: 2000, protein: 150, carbs: 250, fat: 67 },
      { date: '2026-10-02', calories: 2400, protein: 150, carbs: 250, fat: 67 },
    );
    user.water.push({ entry_date: '2026-10-03', water_ml: 960 });
    const key = fake.mintKey('u');
    const client = new SparkyClient({ baseUrl: fake.baseUrl, fetch: fake.fetch });
    return { fake, user, key, client };
  }

  it('only looks up goals when asked, and only for days not already known', async () => {
    const { fake, key, client } = setup();
    await fetchMerged(client, key, '2026-10-01', '2026-10-03');
    expect(fake.calls.filter((c) => c.includes('/api/goals/'))).toEqual([]);

    const { merged } = await fetchMerged(client, key, '2026-10-01', '2026-10-03', {
      goals: { known: { '2026-10-01': { calories: 2500 } } },
    });
    expect(fake.calls.filter((c) => c.includes('/api/goals/')).sort()).toEqual([
      'GET /api/goals/by-date/2026-10-02',
      'GET /api/goals/by-date/2026-10-03',
    ]);
    const v = (d: string, m: string) => merged.find((r) => r.date === d && r.metric === m)?.value;
    expect(v('2026-10-01', 'calorie_adherence')).toBe(60); // 2000 vs the known 2500
    expect(v('2026-10-02', 'calorie_adherence')).toBe(60); // 2400 vs the default 2000
    expect(v('2026-10-03', 'water_goal')).toBe(50);
  });

  it('starts and ends a fast that then counts', async () => {
    const { key, client } = setup();
    const f = await client.startFast(key, {
      start_time: '2026-10-01T20:00:00Z',
      target_end_time: '2026-10-02T12:00:00Z',
      fasting_type: '16:8',
    });
    expect((await client.currentFast(key))?.id).toBe(f.id);
    await client.endFast(key, f.id, '2026-10-02T13:00:00Z');
    expect(await client.currentFast(key)).toBeNull();
    const { merged } = await fetchMerged(client, key, '2026-10-01', '2026-10-03');
    expect(merged.find((r) => r.metric === 'fast_hours')).toMatchObject({
      date: '2026-10-02',
      value: 17,
    });
  });
});

describe('events behind the scores', () => {
  const entries: MergeInput['exerciseEntries'] = [
    {
      entry_date: '2026-10-01',
      exercise_name: 'running',
      duration_minutes: 40,
      calories_burned: 450,
      exercise_source: 'garmin',
    },
    // The same session written by a second app: counted once.
    {
      entry_date: '2026-10-01',
      exercise_name: 'Run',
      duration_minutes: 41,
      calories_burned: 452,
      exercise_source: 'strava',
    },
    { entry_date: '2026-10-01', exercise_name: 'Yoga', duration_minutes: 30, calories_burned: 100 },
    // A forgotten session and the synthetic whole-day entry never count.
    {
      entry_date: '2026-10-02',
      exercise_name: 'Cycling',
      duration_minutes: 600,
      calories_burned: 3000,
    },
    {
      entry_date: '2026-10-02',
      exercise_name: 'Active Calories',
      duration_minutes: 0,
      calories_burned: 900,
    },
    {
      entry_date: '2026-10-02',
      exercise_name: 'Squat',
      exercise_source: 'liftosaur',
      sets: [
        { set_type: 'Warm-up', reps: 5, weight: 60 },
        { set_type: 'Working Set', reps: 5, weight: 100 },
        { set_type: 'Working Set', reps: 3, weight: 110 },
      ],
    },
  ];
  const fasts: MergeInput['fasts'] = [
    {
      id: 'f1',
      start_time: '2026-10-01T03:00:00Z',
      end_time: '2026-10-01T20:00:00Z',
      target_end_time: '2026-10-01T19:00:00Z',
      duration_minutes: 1020,
      fasting_type: '16:8',
      status: 'COMPLETED',
    },
    {
      id: 'f2',
      start_time: '2026-10-02T03:00:00Z',
      end_time: '2026-10-02T09:00:00Z',
      target_end_time: '2026-10-02T19:00:00Z',
      status: 'COMPLETED',
    },
    { id: 'f3', start_time: '2026-10-03T03:00:00Z', status: 'ACTIVE' },
  ];
  const input = {
    start: '2026-10-01',
    end: '2026-10-03',
    exerciseEntries: entries,
    fasts,
    timezone: 'UTC',
  };

  it('lists the cleaned workouts, lift sessions and finished fasts', () => {
    const events = buildEvents(input);
    const w = events.filter((e) => e.event.kind === 'workout');
    expect(w.map((e) => [e.date, e.event.title, e.event.detail, e.event.source])).toEqual([
      ['2026-10-01', 'Running', '40 min · 450 kcal', 'garmin'],
      ['2026-10-01', 'Yoga', '30 min · 100 kcal', null],
    ]);
    const l = events.find((e) => e.event.kind === 'lift')!;
    expect(l).toMatchObject({ date: '2026-10-02' });
    expect(l.event.title).toBe('Squat');
    expect(l.event.detail).toBe('2 sets · top 110 kg × 3 · 830 kg volume');
    const f = events.filter((e) => e.event.kind === 'fast');
    expect(f.map((e) => [e.date, e.event.detail])).toEqual([
      ['2026-10-01', '17 h fasted · target 16 h'],
      ['2026-10-02', '6 h fasted · target 16 h, ended early'],
    ]);
  });

  it('adds up to exactly what was scored', () => {
    const merged = mergeDaily({ ...empty, exerciseEntries: entries, fasts, timezone: 'UTC' });
    const events = buildEvents(input);
    const sum = (kind: string, pick: (d: string) => number) =>
      events.filter((e) => e.event.kind === kind).reduce((a, e) => a + pick(e.event.detail), 0);
    // workouts: count and calories match the daily values
    expect(val(merged, '2026-10-01', 'workouts')).toBe(
      events.filter((e) => e.event.kind === 'workout' && e.date === '2026-10-01').length,
    );
    expect(sum('workout', (d) => Number(/(\d+) kcal/.exec(d)?.[1] ?? 0))).toBe(
      val(merged, '2026-10-01', 'active_calories'),
    );
    // lift volume matches
    expect(
      sum('lift', (d) => Number(/([\d,]+) kg volume/.exec(d)?.[1]?.replace(',', '') ?? 0)),
    ).toBe(val(merged, '2026-10-02', 'lift_volume'));
    // fast hours match to the displayed precision
    expect(val(merged, '2026-10-01', 'fast_hours')).toBe(17);
  });

  it('stays inside the window and never emits weight', () => {
    const events = buildEvents({ ...input, start: '2026-10-02' });
    expect(events.every((e) => e.date >= '2026-10-02')).toBe(true);
    expect(events.some((e) => /weight/i.test(e.event.title))).toBe(false);
  });

  it('fetchEvents asks SparkyFitness only for what the kinds need', async () => {
    const fake = new FakeSparky();
    const user = fake.addUser({ id: 'u', email: 'u@x.test', password: 'p', name: 'U' });
    user.exerciseEntries.push(...entries);
    user.fasts.push(...(fasts as never[]));
    const key = fake.mintKey('u');
    const client = new SparkyClient({ baseUrl: fake.baseUrl, fetch: fake.fetch });
    const fastOnly = await fetchEvents(client, key, '2026-10-01', '2026-10-03', {
      kinds: ['fast'],
      timezone: 'UTC',
    });
    expect(fastOnly.map((e) => e.event.kind)).toEqual(['fast', 'fast']);
    expect(fake.calls.some((c) => c.includes('/api/reports'))).toBe(false);
    fake.calls.length = 0;
    const lifts = await fetchEvents(client, key, '2026-10-02', '2026-10-02', { kinds: ['lift'] });
    expect(lifts).toHaveLength(1);
    expect(fake.calls.some((c) => c.includes('/api/fasting'))).toBe(false);
  });
});

describe('stats kept for Trends beyond what challenges ask for', () => {
  function setup() {
    const fake = new FakeSparky();
    const user = fake.addUser({ id: 'u', email: 'u@x.test', password: 'p', name: 'U' });
    user.categories.push(
      { id: 'c-mood', name: 'Mood', frequency: 'Daily', data_type: 'numeric' },
      { id: 'c-note', name: 'Note', frequency: 'Daily', data_type: 'text' },
      { id: 'c-dist', name: 'distance', frequency: 'Daily', data_type: 'numeric' },
    );
    user.custom['c-mood'] = [
      { date: '2026-10-01', value: '6', timestamp: '2026-10-01T10:00:00Z' },
      { date: '2026-10-02', value: '8', timestamp: '2026-10-02T10:00:00Z' },
    ];
    user.exerciseEntries.push(
      { entry_date: '2026-10-01', exercise_name: 'Squat', sets: [{ reps: 5, weight: 100 }] },
      { entry_date: '2026-10-02', exercise_name: 'Squat', sets: [{ reps: 5, weight: 105 }] },
      { entry_date: '2026-10-02', exercise_name: 'Deadlift', sets: [{ reps: 3, weight: 150 }] },
    );
    const key = fake.mintKey('u');
    return { fake, key, client: new SparkyClient({ baseUrl: fake.baseUrl, fetch: fake.fetch }) };
  }

  it('reads nothing extra unless asked', async () => {
    const { fake, key, client } = setup();
    const { merged } = await fetchMerged(client, key, '2026-10-01', '2026-10-03');
    expect(merged.some((m) => m.metric === 'custom:mood')).toBe(false);
    expect(merged.some((m) => m.metric.startsWith('lift_max:'))).toBe(false);
    expect(fake.calls.some((c) => c.includes('custom-measurements-range/c-mood'))).toBe(false);
  });

  it('also tracks custom measurements and every exercise, without text or built-in ones', async () => {
    const { fake, key, client } = setup();
    const { merged } = await fetchMerged(client, key, '2026-10-01', '2026-10-03', {
      allCustom: true,
      allLifts: true,
    });
    const v = (d: string, m: string) => merged.find((r) => r.date === d && r.metric === m)?.value;
    expect(v('2026-10-02', 'custom:mood')).toBe(8);
    expect(v('2026-10-02', 'lift_max:squat')).toBe(105);
    expect(v('2026-10-02', 'lift_max:deadlift')).toBe(150);
    expect(v('2026-10-02', 'lift_e1rm:deadlift')).toBe(165);
    // The text category was not read, and 'distance' keeps feeding the built-in distance metric.
    expect(fake.calls.filter((c) => c.includes('custom-measurements-range')).length).toBe(2);
    expect(merged.some((m) => m.metric === 'custom:note' || m.metric === 'custom:distance')).toBe(
      false,
    );
  });

  it('lets a challenge keep its own aggregate for the same measurement', async () => {
    const { key, client } = setup();
    const { merged } = await fetchMerged(client, key, '2026-10-01', '2026-10-03', {
      allCustom: true,
      customMetrics: { mood: 'sum' },
    });
    expect(merged.find((r) => r.metric === 'custom:mood' && r.date === '2026-10-02')?.value).toBe(
      8,
    );
  });
});
