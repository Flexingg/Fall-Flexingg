# Gauntlet

Fitness challenges with your friends, on top of [SparkyFitness](https://github.com/CodeWithCJ/SparkyFitness).
Pick any metric (steps, distance, active minutes, calories, workouts, sleep, resting heart rate, or any
SparkyFitness custom measurement), set the rules, invite your crew, and race.

- **PWA** (installable web app) and **Android app** from one React codebase (Capacitor).
- **SparkyFitness holds all raw health data.** Gauntlet stores only users, friends, challenges and a
  per-day scoring cache that can be rebuilt at any time.
- Sign in with your SparkyFitness account. Devices (Garmin, Strava, Fitbit, Oura, Polar, Withings…)
  are connected in SparkyFitness; on Android, Gauntlet can also push Health Connect data into it.

<p>
  <img src="design/app/01-today.png" width="200" alt="Today">
  <img src="design/app/03-challenge.png" width="200" alt="Challenge standings">
  <img src="design/app/04-new-challenge.png" width="200" alt="New challenge">
  <img src="design/app/08-result.png" width="200" alt="Result">
</p>

## How it fits together

```
PWA / Android app ──HTTPS──▶ Gauntlet API (Node + Postgres) ──per-user API key──▶ SparkyFitness
        │                          │
   Health Connect ── records ──────┘ (forwarded to SparkyFitness, not stored)
```

- **Sign-in:** the API signs in to SparkyFitness for you (email/password, with 2FA if enabled),
  creates an API key named "Gauntlet" in your account, stores it encrypted (AES-256-GCM), and signs
  the SparkyFitness session out. Accounts created with Google sign-in have no password, so they
  paste an API key instead (SparkyFitness → Settings → API keys).
- **Sync:** every 15 minutes the API pulls data for everyone in a running challenge, and on demand
  when you pull to refresh. SparkyFitness stores the same metric in different places depending on the
  source; `apps/api/src/sparky/merge.ts` turns that into one number per day. Sources are never added
  together (a watch and a phone count the same walk), the highest single source wins.
- **Privacy:** friends see challenge totals and ranks only. Which app your data came from is shown
  on the feed only if you allow it.

## Repository

| Path              | What                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `packages/shared` | Metric catalog, scoring engine (total, race to target, daily average, best day, streak), API types |
| `apps/api`        | Fastify API, SparkyFitness client and merge, friends, invites, challenges, feed, scheduler         |
| `apps/web`        | React PWA; `apps/web/android` is the Capacitor Android project                                     |
| `deploy/`         | `hermes/`: release deploy on hermes-pc (port 3333); plus a generic Docker Compose setup            |
| `scripts/`        | `make-keystore.sh`: creates the Android release signing key                                        |
| `design/`         | Mockups, icon, and screenshots of the real app (`design/app/`)                                     |

## Develop

Needs Node 22, pnpm 10 and Postgres 16.

```bash
pnpm install
createdb gauntlet && createdb gauntlet_test

# API against a fake SparkyFitness with a seeded crew (resets the database it is given)
DATABASE_URL=postgres://localhost/gauntlet pnpm --filter @gauntlet/api demo
# Web app on http://localhost:5173, proxied to the API on :8080
pnpm --filter @gauntlet/web dev
# Sign in as you@example.com / demo
```

To check a real SparkyFitness account (read-only; prints what Gauntlet would score for the last week):

```bash
SPARKY_TEST_KEY=<api key> pnpm --filter @gauntlet/api live-check
```

To develop against your real server instead, copy `apps/api/.env.example` to `apps/api/.env`, fill it
in, and run `pnpm --filter @gauntlet/api dev`.

```bash
pnpm typecheck
TEST_DATABASE_URL=postgres://localhost/gauntlet_test pnpm test   # unit + API integration tests
pnpm --filter @gauntlet/web build && pnpm --filter @gauntlet/web e2e   # needs the demo API running
```

## Release and deploy

Publishing a GitHub release builds a signed Android APK, attaches it to the release, and deploys the
web app and API on hermes-pc (port 3333, published by Cloudflare), with the APK downloadable from the
app's Profile page. Setup and operation: [`deploy/hermes/README.md`](deploy/hermes/README.md).

For any other host, `deploy/docker-compose.yml` runs the same image (API + PWA on port 8080) with
Postgres; copy `deploy/.env.example` to `deploy/.env` and run
`docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build`. Keep
`ENCRYPTION_KEY` stable: changing it makes every stored SparkyFitness key unreadable, and everyone has
to sign in again.

No changes are needed on the SparkyFitness server: Gauntlet calls it server-side, so its CORS and
trusted-origin settings don't apply to the apps. One thing to know: SparkyFitness allows 4 sign-ins
per minute per IP, and every Gauntlet sign-in comes from Gauntlet's server. If several people sign
in at once they may see "too many attempts"; raise `SPARKY_FITNESS_SIGN_IN_RATELIMIT_*` on the
SparkyFitness server if that becomes a problem. (Syncing uses API keys and isn't affected.)

## Android

```bash
pnpm --filter @gauntlet/web cap:sync      # builds with apps/web/.env.native (VITE_API_URL)
cd apps/web/android && ./gradlew assembleDebug
```

- Releases are built by CI with `GAUNTLET_PUBLIC_URL` as the API address. `.env.native` is only for
  local builds.
- Pushes and pull requests build a debug APK (artifact `gauntlet-android`).
- Health Connect: the app asks for read access only (steps, distance, active calories, resting heart
  rate, sleep, exercise, history) and syncs when opened or resumed. Records use the same format and
  source name as the SparkyFitness app, so if you already run that, you only need one of them syncing.
- Icons and splash screens come from `apps/web/public/icons/*.svg`: `pnpm --filter @gauntlet/web icons`.

## Status

Built and tested: API flows (password, 2FA and API-key login; friends; invite links; challenges in
every scoring mode; multi-source sync; feed; finalization; rematch; revoked keys), the PWA (Playwright
walkthrough of every screen), the production layout, and an Android debug build.

Verified against fit.randalls.cc with a real account: API-key sign-in, sync, Today, a steps
challenge, Trends and Data sources. That data led to the workout clean-up rules in
`apps/api/src/sparky/merge.ts`, which drop stuck sessions over 6 hours and duplicates written by two
apps, and cap sleep at time in bed. Not yet verified: password and 2FA sign-in against the real server,
and Health Connect on a physical device. Push notifications and background Health Connect sync
(WorkManager) are planned follow-ups.
