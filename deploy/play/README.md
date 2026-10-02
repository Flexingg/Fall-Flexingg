# Google Play Store release

Everything the Play Console asks for, ready to paste. Replace `gauntlet.randalls.cc` with your server.

## Before you start (things only you can do)
1. A Play Console developer account ($25 once). **Personal accounts created after Nov 2023 must run a closed test with 12+ testers for 14 days before production** — start that first.
2. Run **Release** (`release.yml`): it now attaches `gauntlet-<tag>.aab` (the upload file for Play) next to the APK.
3. **Play App Signing:** upload the `.aab` signed with your existing key (it becomes the *upload key*). Play then re-signs for users, so open Play Console → App integrity → *App signing key certificate* and add its SHA-256 to the `ASSETLINKS_SHA256` secret/variable (comma separated, keep the existing one) so invite links keep opening the app, then re-run Fly deploy.
4. Set the contact address shown on the privacy page: `CONTACT_EMAIL` (or `ADMIN_EMAILS`; the first one is used).
5. Version codes come from the CI run number, so every upload is higher than the last.

## Required URLs
| Console field | URL |
|---|---|
| Privacy policy | `https://gauntlet.randalls.cc/privacy` |
| Account deletion (Data safety → Delete account URL) | `https://gauntlet.randalls.cc/delete-account` |
| Terms (optional, in listing) | `https://gauntlet.randalls.cc/terms` |

In-app account deletion: **Me → Delete Gauntlet account** (also on the web).

## Store listing
- **App name:** Gauntlet
- **Short description (80):** Fitness challenges with friends, scored from your own SparkyFitness data.
- **Full description:**
  Gauntlet turns your fitness data into friendly competition. Start a challenge with friends (most steps, a weekend 100K, a protein streak, heaviest squat), race them on a live leaderboard and progress graph, and see exactly what counted. Or go solo: set a target, hold a daily average, build a streak, or beat last month's you.

  • Challenges with friends or open to the public, with day-by-day progress graphs
  • Solo challenges: hit a target, keep an average, build a streak, or improve by a percentage
  • Dozens of stats: steps, distance, calories, sleep, resting heart rate, workouts, lifting volume and per-exercise bests, nutrition and macro goals, water, fasting, weight-goal progress
  • "Show Events" lets a challenge show the workouts that count (you can opt out)
  • Private by default; you choose whether your profile is public
  • Reads Health Connect (steps, distance, calories, heart rate, sleep, exercise) and your SparkyFitness account, plus Strava, Fitbit, Garmin, Oura and Polar through SparkyFitness
  • No ads, no tracking

  Gauntlet works with a SparkyFitness account (create one inside the app).
- **Category:** Health & Fitness. **Tags:** fitness tracker, workout, social.
- **Graphics you must supply:** 512×512 icon, 1024×500 feature graphic, 2–8 phone screenshots (take them from the demo server: `pnpm demo`, then `apps/web/e2e/screens.spec.ts` produces 390px screenshots).

## App content
- **Target audience:** 13+ (not directed at children). **Ads:** none. **App access:** reviewers need a login — create a test account on your SparkyFitness and give its email/password in *App access*.
- **Content rating (IARF):** no violence/sexual content; **user-generated content: yes** (challenge names, handles). Answer "users can interact" yes, "share location" no.
- **UGC policy:** names are visible only to friends/challenge members unless the person goes public; the operator can remove challenges and people (see `ADMIN_EMAILS`). Consider adding in-app report/block before large public launch.
- **Health apps declaration:** Health & fitness app, no medical device claims; links to disclaimer in the terms.

## Health Connect permission declaration
Permissions: `READ_STEPS`, `READ_DISTANCE`, `READ_ACTIVE_CALORIES_BURNED`, `READ_RESTING_HEART_RATE`, `READ_SLEEP`, `READ_EXERCISE` (all read-only).
- **Why:** each is a stat people can compete on; values are summed per day and forwarded to the person's own SparkyFitness server, which Gauntlet reads to score challenges.
- **Handling:** not used for ads, not sold, not shared with third parties other than the person's own SparkyFitness server; the rationale screen is opened from Health Connect (`ACTION_SHOW_PERMISSIONS_RATIONALE`) and the privacy policy explains it.
- Reduce this list in `AndroidManifest.xml` if you don't want to justify one.

## Data safety form
| Data | Collected | Shared | Purpose | Optional | Deletable |
|---|---|---|---|---|---|
| Name, email address, user IDs | Yes | No | App functionality, account management | No | Yes |
| Health info (steps, sleep, heart rate, workouts via Health Connect/SparkyFitness) | Yes | No* | App functionality | Yes | Yes |
| Fitness info (exercise, distance, calories) | Yes | No* | App functionality | Yes | Yes |
| Other user content (challenge names, friends list, scores) | Yes | No | App functionality | Yes | Yes |
| Device/other IDs, location, contacts, photos, financial | No | — | — | — | — |
*Data goes to the user's own SparkyFitness server and Fly.io hosting acting as processors, which Play does not count as "sharing".
- Data is encrypted in transit: **yes**. Users can request deletion: **yes** (in-app + the URL above). No ad or analytics SDKs.
