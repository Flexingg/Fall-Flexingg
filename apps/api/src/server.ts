import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb, runMigrations } from './db/index.js';
import { seedBadges } from './services/badges/seed.js';
import { refreshDemo } from './services/demo.js';
import { startScheduler } from './scheduler.js';
import { startReleaseMirror } from './githubRelease.js';
import { SparkyClient } from '@gauntlet/sparky';

const cfg = loadConfig();
const { db, client } = createDb(cfg.DATABASE_URL);
await runMigrations(db);

const { app, ctx } = await buildApp(
  { db, cfg, sparky: new SparkyClient({ baseUrl: cfg.SPARKY_URL }), now: () => new Date() },
  { logger: { level: cfg.LOG_LEVEL } },
);
// The launch badges (before the demo account, whose sample badges point at them).
await seedBadges(ctx).catch((err) => ctx.log.warn({ err }, 'badge seed failed'));
void refreshDemo(ctx).catch((err) => ctx.log.warn({ err }, 'demo setup failed'));
const stopSync = startScheduler(ctx, cfg.SYNC_INTERVAL_MINUTES);
// The Android app's downloads and update checks come from the newest GitHub release.
const stopMirror =
  cfg.DOWNLOADS_DIR && cfg.GITHUB_RELEASES_REPO
    ? startReleaseMirror({
        repo: cfg.GITHUB_RELEASES_REPO,
        token: cfg.GITHUB_TOKEN || undefined,
        dir: cfg.DOWNLOADS_DIR,
        minutes: cfg.GITHUB_RELEASE_CHECK_MINUTES,
        log: (msg, extra) => ctx.log.info(extra ?? {}, msg),
        onError: (err) => ctx.log.warn({ err }, 'checking GitHub for an Android release failed'),
      })
    : () => undefined;
const stop = () => {
  stopSync();
  stopMirror();
};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    stop();
    await app.close();
    await client.end({ timeout: 5 });
    process.exit(0);
  });
}

await app.listen({ port: cfg.PORT, host: cfg.HOST });
