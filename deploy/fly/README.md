# Gauntlet on Fly.io

Four small apps in one Fly organisation, US East (`iad`). Names come from the `FLY_APP_PREFIX`
repository variable; with `gauntlet`:

| App                   | What                                                   | Public?              | Size                       |
| --------------------- | ------------------------------------------------------ | -------------------- | -------------------------- |
| `gauntlet`            | Gauntlet API + web app (the address people use)        | yes                  | 512 MB, always on          |
| `gauntlet-sparky`     | SparkyFitness website; proxies `/api` to the server    | yes                  | 256 MB, sleeps when idle   |
| `gauntlet-sparky-api` | SparkyFitness server (pinned `v1.7.3`)                 | no (private network) | 512 MB + swap, 1 GB volume |
| `gauntlet-db`         | Postgres 18: databases `gauntlet` + `sparkyfitness_db` | no (private network) | 512 MB, 3 GB volume        |

Gauntlet talks to SparkyFitness over Fly's private network. Phones and browsers use the public
addresses. **Cost:** roughly $9–11 a month (three always-on small machines plus volumes; the
SparkyFitness website costs next to nothing while it sleeps). Check [fly.io/pricing](https://fly.io/docs/about/pricing/).

## One-time setup

1. **Fly account.** Sign up at fly.io (a card is required). In the dashboard, create a deploy
   token for your organisation: _Tokens → Create token → Org deploy token_ (or `fly tokens create org`).
2. **GitHub** (repo → Settings → Secrets and variables → Actions):
   - Secret `FLY_API_TOKEN`: the token.
   - Variable `FLY_APP_PREFIX`: a name that's free on Fly, lowercase, e.g. `randalls-gauntlet`.
   - Variable `GAUNTLET_PUBLIC_URL`: e.g. `https://gauntlet.randalls.cc`.
   - Variable `SPARKY_PUBLIC_URL`: e.g. `https://sparky.randalls.cc` (a new name, so your existing
     fit.randalls.cc keeps working).
   - Optional: `SPARKY_ADMIN_EMAIL` (that account becomes the SparkyFitness admin; otherwise the
     first account created is), `FLY_ORG` (default `personal`).
   - The Android signing secrets, if not done yet: run `scripts/make-keystore.sh`.
3. **Run _Actions → Fly setup_.** It creates the apps, generates every secret straight into Fly
   (none are printed or stored in GitHub), registers your two domains, validates the configs and
   deploys. The log ends with the DNS records to add.
4. **Cloudflare DNS:** for each domain add a `CNAME` to `<app>.fly.dev` (shown in the log) with the
   proxy **off** (grey cloud). Fly issues the certificates in a few minutes
   (`fly certs show <domain> -a <app>`). You can turn the Cloudflare proxy on afterwards with SSL mode
   **Full (strict)**.
5. **Publish a release** (e.g. `v0.2.0`). The APK it builds points at your two addresses and is
   downloadable from the app.
6. **Create your account first** in the app: it becomes the SparkyFitness admin unless you set
   `SPARKY_ADMIN_EMAIL`.

## Day to day

- Every published release deploys all four apps in order (database, SparkyFitness server, website,
  Gauntlet) and then checks them. Gauntlet deploys blue-green: a build that fails its health check
  never replaces the running one. _Release → Run workflow_ with an empty tag deploys the selected
  branch as a dev build.
- Upgrading SparkyFitness: change the image tag in `sparky-api.toml` and `sparky-web.toml` (same
  version in both), then release. Read its release notes first; it migrates its database on start.
- Logs: `fly logs -a <app>`. Status: `fly status -a <app>`.

## Backups

- Fly snapshots both volumes daily and keeps 14 days (`fly volumes snapshots list <volume id>`).
  To restore, create a volume from a snapshot (`fly volumes create pgdata --snapshot-id <id> -a <prefix>-db`)
  and move the machine onto it.
- A portable dump any time:
  `fly ssh console -a <prefix>-db -C "pg_dump -U postgres -Fc sparkyfitness_db" > sparky.dump`
  (same for `gauntlet`). Restore with `pg_restore`; for SparkyFitness, start the app first so its
  migrations don't overwrite the restored data (see its docs).

## Secrets

`setup.sh` only creates secrets that are missing, so re-running it is safe. Never change these
once in use: Gauntlet `ENCRYPTION_KEY` and `JWT_SECRET`; SparkyFitness `BETTER_AUTH_SECRET` and
`SPARKY_FITNESS_API_ENCRYPTION_KEY`. The database passwords are created together on the first run;
if one app somehow has them and another doesn't, setup stops rather than create passwords that don't
match. Fix that by setting matching values with `fly secrets set` (and `ALTER ROLE` inside Postgres
via `fly ssh console -a <prefix>-db`).

## Files

- `common.sh`, `setup.sh`, `deploy.sh`: what the workflows run; you can run them locally with
  `flyctl` logged in.
- `*.toml`: one Fly config per app. `../postgres/` builds the database image (creates both
  databases on first start).
- `downloads/`: the release workflow drops the APK here so it ships inside the Gauntlet image.
