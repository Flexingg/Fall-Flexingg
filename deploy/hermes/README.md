# Gauntlet on hermes-pc

Every GitHub **release** runs `.github/workflows/release.yml`:

1. **Build signed APK** (GitHub-hosted runner): builds the Android app with your public URL baked in,
   signs it with your release key, checks the signature, attaches `gauntlet-<tag>.apk` to the release.
2. **Deploy** (self-hosted runner on hermes-pc): runs `deploy/hermes/deploy.sh`, which publishes the
   APK, builds the Docker image, restarts the stack on **port 3333**, checks it is healthy, and rolls
   back to the previous version if it is not.

Port 3333 serves the full web/PWA app, the API (`/api`), and the APK (`/downloads/gauntlet-latest.apk`;
the web app's Profile page has a Download button). Cloudflare then publishes that port at your URL.

## One-time setup

### 1. Release signing key (on any machine with a JDK)

```bash
scripts/make-keystore.sh ~/gauntlet-keys
```

**Back up `gauntlet-release.jks`.** Phones only accept updates signed with the same key; lose it and
everyone must uninstall Gauntlet (losing its local data) to get a new build. The script prints the
four secrets to add under GitHub repo → Settings → Secrets and variables → Actions:
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.

### 2. Public URL (GitHub repo variable)

Same page, **Variables** tab (optional for the APK, which can run without a server; needed for the web deploy): `GAUNTLET_PUBLIC_URL` = the https URL Cloudflare will serve (for example
`https://gauntlet.example.com`). It is baked into the APK as the API address, so it must be final.
It cannot be changed without publishing a new release.

### 3. hermes-pc

Needs Docker with the Compose plugin, `curl`, and `git`.

```bash
# Config and data live outside the repo checkout, so runner clean-ups never touch them.
sudo mkdir -p /opt/gauntlet/downloads && sudo chown -R "$USER" /opt/gauntlet
cp deploy/hermes/.env.example /opt/gauntlet/.env && chmod 600 /opt/gauntlet/.env
$EDITOR /opt/gauntlet/.env      # secrets, PUBLIC_WEB_URL (same as GAUNTLET_PUBLIC_URL)
```

Install the GitHub Actions runner: repo → Settings → Actions → Runners → **New self-hosted runner**
(Linux), follow the commands, and when `./config.sh` asks for labels enter `hermes-pc`. Then run it as
a service so it survives reboots, as a user that can run Docker (`sudo usermod -aG docker <user>`):

```bash
sudo ./svc.sh install <user> && sudo ./svc.sh start
```

Optional: create an environment named `hermes-pc` (Settings → Environments) to require a manual
approval before each deploy.

> The runner executes code from this repository on hermes-pc. Keep the repo private, or only let
> trusted people publish releases.

### 4. Cloudflare

In Cloudflare Zero Trust → Networks → Tunnels, add a public hostname for your URL pointing to
`http://localhost:3333` (or `http://hermes-pc:3333` if `cloudflared` runs elsewhere). Optionally add a
cache rule to bypass the cache for `/api/*`, `/sw.js` and `/downloads/gauntlet-latest.apk`
(the app already sends the right cache headers).

Set `GAUNTLET_BIND=127.0.0.1` in `/opt/gauntlet/.env` if `cloudflared` runs on the same machine and you
don't want 3333 open on your LAN.

### 5. Check it works (do this before your first release)

Run **Actions → Hermes check → Run workflow**. It runs on the hermes-pc runner and tells you, in plain
words, whether Docker is usable by the runner, `/opt/gauntlet` is writable, `/opt/gauntlet/.env` is
complete, port 3333 is free and the machine can reach Docker Hub and SparkyFitness. The same check runs
at the start of every deploy. You can also run it by hand: `deploy/hermes/preflight.sh`.

To try the whole pipeline without publishing a release, run **Actions → Release → Run workflow** and
leave _tag_ empty. It builds a signed APK from the selected branch and deploys it as `dev-<commit>`.

## Releasing

Create a release in GitHub (tag such as `v0.2.0`, letters, digits, `.`, `_` and `-` only). The workflow
does the rest. Re-run a release with _Actions → Release → Run workflow_ and the tag.

## Operating it

```bash
deploy/hermes/deploy.sh v0.2.0 /path/to/gauntlet-v0.2.0.apk   # deploy by hand
docker compose -f deploy/hermes/docker-compose.yml --env-file /opt/gauntlet/.env logs -f gauntlet
docker compose -f deploy/hermes/docker-compose.yml --env-file /opt/gauntlet/.env ps
```

- **Rollback:** automatic when a deploy is unhealthy. To go back manually:
  `docker tag gauntlet:previous gauntlet:deployed` then `docker compose ... up -d`.
- **Backups:** back up `/opt/gauntlet/.env` (especially `ENCRYPTION_KEY`) and the Postgres volume:
  `docker exec gauntlet-db-1 pg_dump -U gauntlet gauntlet > gauntlet-$(date +%F).sql`.
- **Keeps:** the last 3 images and last 5 APKs.
- **Invite links opening the app:** set `ASSETLINKS_SHA256` in `/opt/gauntlet/.env` to the fingerprint
  printed by `make-keystore.sh`; the API then serves `/.well-known/assetlinks.json`.
