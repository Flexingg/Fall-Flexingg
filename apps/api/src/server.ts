import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb, runMigrations } from './db/index.js';
import { startScheduler } from './scheduler.js';
import { SparkyClient } from '@gauntlet/sparky';

const cfg = loadConfig();
const { db, client } = createDb(cfg.DATABASE_URL);
await runMigrations(db);

const { app, ctx } = await buildApp(
  { db, cfg, sparky: new SparkyClient({ baseUrl: cfg.SPARKY_URL }), now: () => new Date() },
  { logger: { level: cfg.LOG_LEVEL } },
);
const stop = startScheduler(ctx, cfg.SYNC_INTERVAL_MINUTES);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    stop();
    await app.close();
    await client.end({ timeout: 5 });
    process.exit(0);
  });
}

await app.listen({ port: cfg.PORT, host: cfg.HOST });
