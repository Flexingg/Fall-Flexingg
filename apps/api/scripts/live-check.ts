/**
 * Read-only check against a real SparkyFitness server: confirms each endpoint
 * Gauntlet uses responds, and prints the merged daily values for the last week.
 *
 *   SPARKY_TEST_KEY=... [SPARKY_URL=https://fit.randalls.cc] pnpm --filter @gauntlet/api live-check
 *
 * Never commit the key; pass it in the environment.
 */
import { addDays, todayIn } from '@gauntlet/shared';
import {
  SparkyClient,
  mergeDaily,
  wantedCategoryNames,
  type CustomMeasurementRow,
} from '@gauntlet/sparky';

const key = process.env.SPARKY_TEST_KEY;
if (!key) {
  console.error('Set SPARKY_TEST_KEY to a SparkyFitness API key.');
  process.exit(1);
}
const sparky = new SparkyClient({ baseUrl: process.env.SPARKY_URL ?? 'https://fit.randalls.cc' });
const end = addDays(todayIn('UTC'), 1);
const start = addDays(end, -30);

async function step<T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    const r = await fn();
    console.log(`ok    ${name}${Array.isArray(r) ? ` (${r.length} rows)` : ''}`);
    return r;
  } catch (err) {
    console.log(`FAIL  ${name}: ${(err as Error).message}`);
    process.exitCode = 1;
    return fallback;
  }
}

const me = await step('identity/user', () => sparky.currentUser(key), null);
if (me) console.log(`      signed in as ${me.name ?? me.email}`);
const cats = await step('custom categories', () => sparky.customCategories(key), []);
const daily = await step(
  'generic-health metrics',
  () => sparky.dailyHealthMetrics(key, start, end),
  [],
);
const checkIns = await step('check-ins', () => sparky.checkIns(key, start, end), []);
const exerciseDays = await step('exercise stats', () => sparky.exerciseDays(key, start, end), []);
const exerciseEntries = await step(
  'exercise entries',
  () => sparky.exerciseEntries(key, start, end),
  [],
);
const sleep = await step('sleep', () => sparky.sleep(key, start, end), []);
await step('synced sources', () => sparky.syncedSources(key), []);

const wanted = new Set(wantedCategoryNames({}));
const custom: Parameters<typeof mergeDaily>[0]['custom'] = {};
for (const c of cats.filter((x) => wanted.has(x.name.toLowerCase()))) {
  const rows = await step(
    `custom "${c.name}"`,
    () => sparky.customMeasurements(key, c.id, start, end),
    [] as CustomMeasurementRow[],
  );
  custom[c.name.toLowerCase()] = { category: c, rows };
}

const merged = mergeDaily({
  start,
  end,
  daily,
  checkIns,
  custom,
  exerciseDays,
  exerciseEntries,
  sleep,
  customMetrics: {},
});
const recent = addDays(end, -7);
console.log('\nLast 7 days as Gauntlet scores them:');
for (const m of merged.filter((x) => x.date >= recent)) {
  console.log(
    `  ${m.date}  ${m.metric.padEnd(16)} ${String(Math.round(m.value * 100) / 100).padStart(9)}  (${m.source})`,
  );
}
