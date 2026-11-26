# Gauntlet

Fitness challenges with your friends (or anyone), on top of [SparkyFitness](https://github.com/CodeWithCJ/SparkyFitness).
Pick a metric, set the rules, invite your crew, and race:

- **Activity:** steps, distance, active minutes, calories, workouts, sleep, resting heart rate.
- **Strength** (sets from Liftosaur, Hevy or SparkyFitness): volume lifted, working sets, or one
  exercise: heaviest set, or estimated 1RM gain % so beginners and veterans compete on improvement.
- **Nutrition:** calorie and macro goals scored as closeness to _each person's own_ goal (100 on
  target, 2 points off per 1% over or under), so someone bulking can race someone cutting; water
  goal %, water, calories eaten, protein, carbs, fat.
- **Body:** weight goal: everyone picks lose or gain and their own target; scored on % of it
  reached. Raw weights never leave the server.
- **Fasting:** hours fasted and fasts completed, from SparkyFitness' fasting tracker (start and end
  fasts from Gauntlet's Today screen).
- **Custom:** any SparkyFitness custom measurement.

**Solo challenges** are challenges against yourself: hit a total, keep a daily average, build a streak,
or beat your past self by a percentage (your daily average, or heaviest lift, vs the days before it
started, up or down). You get a pace, a plain-words status, a progress graph with your goal line, and
the same Show Events. They stay private and can't be shared.

**Trends** covers every stat a challenge can be scored on (activity, strength including each exercise's
heaviest set and estimated 1RM, calorie/macro/water goals, fasting) plus weight and your custom
measurements, with an all-stats overview for the range you pick.

Every challenge page has a **progress graph** (everyone's score day by day, with hover or arrow-key
scrubbing and a table view). Dates are chosen when a challenge is created, in the past or future, and then
stay fixed (Rematch runs it again); the creator can still rename it, make it public or private, and turn
**Show Events** on. With Show Events, participants can open the workouts, lift sessions and fasts behind
each score. Those are read live from each person's SparkyFitness when someone looks (nothing is copied
into Gauntlet), only for people in the challenge, and anyone can opt out under Data sources → Privacy
("Show my workouts in challenges"). Weight is never listed.

Profiles are **private by default** (only friends and challenge-mates see you). Go public to be
found by name or @handle and to join **public challenges** from Discover; server admins
(`ADMIN_EMAILS`) can feature them. Public profiles show name, handle and challenge record only.

**Demo account:** the sign-in screen has a "Try the demo" button. It signs into a built-in account with five made-up friends, 70 days of sample stats and a few challenges (including solo ones), all rebuilt every day. It has no SparkyFitness behind it, so linking apps, fasting and Health Connect are switched off, and it can't add real friends, go public or be deleted. Switch it off with `DEMO_ACCOUNT=false`.

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
PWA / Android app ──HTTPS──▶ Gauntlet API (Node) ──per-user API key──▶ SparkyFitness (bundled)
        │                          │                                      │
   Health Connect ── records ──────┘ (forwarded, not stored)        one Postgres, two databases
```

Gauntlet ships with its own SparkyFitness, which holds everyone's health data; Gauntlet itself
stores accounts, friends and challenges. Both run on Fly.io (see Release and deploy).

- **Accounts:** "Create an account" in the app makes the SparkyFitness account behind the scenes.
  Signing in (email/password, with 2FA if enabled) gets the API to create an API key named
  "Gauntlet" in your SparkyFitness account, store it encrypted (AES-256-GCM), and sign the
  SparkyFitness session out. People who'd rather use another SparkyFitness can sign in with an API
  key from it (Android: Advanced).
- **Sync:** every 15 minutes the API pulls data for everyone in a running challenge, and on demand
  when you pull to refresh. SparkyFitness stores the same metric in different places depending on the
  source; `packages/sparky/src/merge.ts` turns that into one number per day. Sources are never added
  together (a watch and a phone count the same walk), the highest single source wins.
- **Privacy:** friends see challenge totals and ranks only. Which app your data came from is shown
  on the feed only if you allow it.

## Repository

| Path              | What                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `packages/shared` | Metric catalog, scoring engine (total, race to target, daily average, best day, streak), API types |
| `packages/sparky` | SparkyFitness client and the multi-source merge, shared by the API and the Android app             |
| `apps/api`        | Fastify API: accounts, friends, invites, challenges, feed, scheduler                               |
| `apps/web`        | React PWA; `apps/web/android` is the Capacitor Android project                                     |
| `deploy/`         | `fly/`: Fly.io deploy; `docker-compose.yml`: the whole backend on one machine; `smoke.sh`          |
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

Everything runs on [Fly.io](https://fly.io) as five small apps: Gauntlet (API + PWA), the
SparkyFitness server, the SparkyFitness website, and one Postgres holding both databases.
Publishing a GitHub release builds the signed APK, attaches it to the release and deploys all of it,
with the APK downloadable from the app's Profile page. One-time setup, custom domains through
Cloudflare, backups and costs (about $11–13 a month): [`deploy/fly/README.md`](deploy/fly/README.md).

To run the same backend on any machine with Docker: copy `deploy/.env.example` to `deploy/.env`,
fill in the secrets, and run `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build`.
`deploy/smoke.sh <gauntlet url> <sparkyfitness url>` then signs up a test account, pushes steps and
reads them back (CI does this on every push).

Keep `ENCRYPTION_KEY`, `BETTER_AUTH_SECRET` and the SparkyFitness encryption key stable: changing
them makes stored keys unreadable and signs everyone out.

## Android

```bash
pnpm --filter @gauntlet/web cap:sync      # builds with apps/web/.env.native (VITE_API_URL)
cd apps/web/android && ./gradlew assembleDebug
```

- The app signs in (or creates an account) through your Gauntlet server. Release builds point at
  `GAUNTLET_PUBLIC_URL` and `SPARKY_PUBLIC_URL` (repository variables; `.env.native` for local
  builds).
- **Apps and devices** are connected from Data sources: Garmin, Strava, Fitbit, Oura, Polar, COROS,
  Hevy, Liftosaur and wger. SparkyFitness does the connecting and keeps the data synced; the app is a
  friendlier front for it (setup in `deploy/fly/README.md`).
- **Advanced: SparkyFitness only.** With an API key (SparkyFitness → Settings → API keys) and no
  Gauntlet server, the phone talks straight to SparkyFitness (Today, Trends, Data sources, Health
  Connect sync). Friends and challenges need a server; connect one later under Me. The key is kept in
  Android Keystore-backed storage.
- Pushes and pull requests build a debug APK (artifact `gauntlet-android`).
- Health Connect: the app asks for read access only (steps, distance, active calories, resting heart
  rate, sleep, exercise, history) and syncs when opened or resumed. Records use the same format and
  source name as the SparkyFitness app, so if you already run that, you only need one of them syncing.
- **Live wallpaper** (Me → Live wallpaper): a GLES 2 spiral galaxy drawn from today's calories (core),
  protein/carbs/fat (three arms), water (outer ring) and volume lifted (jets, against your best same
  weekday of the last 8 weeks). The app hands the wallpaper its latest numbers through Capacitor
  Preferences, so it shows what Gauntlet last synced. The shader in `apps/web/shaders/` is shared by
  the wallpaper and the in-app preview.
- **Widget and Wear OS.** The app publishes a small snapshot of Today (steps, active calories and
  minutes against your goals, plus the featured running challenge with your rank) every time Today
  refreshes while the app is open.
  - _Home-screen widget_ ("Gauntlet today"): long-press the home screen, Widgets, Gauntlet. 2x2 shows
    the three rings and steps; stretch it to 4x2 for the numbers and your challenge (tap it to open
    that challenge). It only changes when the app publishes, so after a few hours it greys out and
    says "Open Gauntlet to refresh" instead of showing old numbers as current.
  - _Wear OS tile_: a steps arc with your challenge rank, in `apps/web/android/wear` (same
    `cc.randalls.gauntlet` id as the phone app, so the Wearable Data Layer pairs them; it needs Google
    Play services on the phone and a paired watch). There is no Play Store listing, so each release
    attaches `gauntlet-wear-<tag>.apk` (+ `.sha256`). Install it from a computer: on the watch enable
    Developer options, ADB debugging and Debug over Wi-Fi, then
    `adb connect <watch-ip>:5555` and `adb install gauntlet-wear-<tag>.apk`. Then add the "Gauntlet
    today" tile from the watch's tile list. Open Gauntlet on the phone once so it sends the first numbers.
- Icons and splash screens come from `apps/web/public/icons/*.svg`: `pnpm --filter @gauntlet/web icons`.

## Status

Built and tested: API flows (password, 2FA and API-key login; friends; invite links; challenges in
every scoring mode; multi-source sync; feed; finalization; rematch; revoked keys), the PWA (Playwright
walkthrough of every screen), the production layout, and an Android debug build.

Verified against fit.randalls.cc with a real account: API-key sign-in, sync, Today, a steps
challenge, Trends and Data sources. That data led to the workout clean-up rules in
`packages/sparky/src/merge.ts`, which drop stuck sessions over 6 hours and duplicates written by two
apps, and cap sleep at time in bed.

Verified against the bundled SparkyFitness (v1.7.3, real container): creating an account through
Gauntlet, password sign-in, pushing Health Connect-style records and reading them back on Today.
The new metrics were checked the same way: food, water, goals, a fast and a squat session with a
warm-up logged in the real container come out as calorie/macro/water adherence, hours fasted, volume
(warm-ups excluded), heaviest set and estimated 1RM. Liftosaur and Hevy imports label warm-ups and
store kilograms the way these rules expect. Not yet verified: a live Liftosaur account's synced sets.
Not yet verified: the live Fly.io deploy (needs your Fly account), 2FA against a real server, and
Health Connect on a physical device. Push notifications and background Health Connect sync
(WorkManager) are planned follow-ups.
