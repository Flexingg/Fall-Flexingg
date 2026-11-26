import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { readAndroidRelease, type AndroidRelease } from './downloads.js';

/**
 * Keeps DOWNLOADS_DIR in step with the newest GitHub release: downloads its APK (checked against the
 * release's .sha256 file when there is one), then writes gauntlet-<tag>.apk, gauntlet-latest.apk and
 * latest.json, the files /api/app/android and /downloads serve. A private repository needs a token
 * that can read its contents; phones never talk to GitHub themselves.
 */
export interface GithubReleaseOptions {
  /** "owner/name". */
  repo: string;
  token?: string;
  dir: string;
  fetch?: typeof fetch;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

interface GhAsset {
  id: number;
  name: string;
  size: number;
  url: string;
}
interface GhRelease {
  tag_name: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
  assets: GhAsset[];
}

const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type MirrorResult =
  | { status: 'updated'; release: AndroidRelease }
  | { status: 'current'; release: AndroidRelease }
  | { status: 'no_apk' };

export async function mirrorLatestRelease(opts: GithubReleaseOptions): Promise<MirrorResult> {
  const f = opts.fetch ?? fetch;
  const headers: Record<string, string> = {
    'User-Agent': 'gauntlet-server',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const res = await f(`https://api.github.com/repos/${opts.repo}/releases/latest`, {
    headers: { ...headers, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) {
    const hint =
      res.status === 404 && !opts.token
        ? ' (a private repository needs GITHUB_TOKEN)'
        : res.status === 404
          ? ' (no published release yet, or the token cannot read this repository)'
          : '';
    throw new Error(`GitHub releases/latest returned ${res.status}${hint}`);
  }
  const rel = (await res.json()) as GhRelease;
  const tag = rel.tag_name;
  if (!TAG_RE.test(tag)) throw new Error(`Release tag "${tag}" can't be used as a file name`);
  // The phone APK: gauntlet-<tag>.apk if present, else any .apk that isn't the Wear OS one.
  const phoneApks = rel.assets.filter(
    (a) => a.name.endsWith('.apk') && !a.name.startsWith('gauntlet-wear-'),
  );
  const apk = phoneApks.find((a) => a.name === `gauntlet-${tag}.apk`) ?? phoneApks[0];
  if (!apk) return { status: 'no_apk' };

  const file = `gauntlet-${tag}.apk`;
  const current = await readAndroidRelease(opts.dir);
  if (current?.version === tag && (await isFile(join(opts.dir, file)))) {
    return { status: 'current', release: current };
  }

  const download = (asset: GhAsset) =>
    f(asset.url, { headers: { ...headers, Accept: 'application/octet-stream' } });

  // The release workflow publishes "<sha256>  <file>" next to the APK.
  let expected = '';
  const sumAsset = rel.assets.find((a) => a.name === `${apk.name}.sha256`);
  if (sumAsset) {
    const sumRes = await download(sumAsset);
    if (!sumRes.ok) throw new Error(`Downloading ${sumAsset.name} returned ${sumRes.status}`);
    expected = (await sumRes.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  }

  await mkdir(opts.dir, { recursive: true });
  const tmp = join(opts.dir, `.download-${process.pid}-${Date.now()}.apk`);
  try {
    const apkRes = await download(apk);
    if (!apkRes.ok || !apkRes.body)
      throw new Error(`Downloading ${apk.name} returned ${apkRes.status}`);
    const hash = createHash('sha256');
    let size = 0;
    await pipeline(
      Readable.fromWeb(apkRes.body as unknown as WebReadableStream<Uint8Array>),
      new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          size += chunk.length;
          cb(null, chunk);
        },
      }),
      createWriteStream(tmp),
    );
    const sha256 = hash.digest('hex');
    if (expected && expected !== sha256)
      throw new Error(`${apk.name} checksum mismatch (expected ${expected}, got ${sha256})`);

    // Versioned file first, then the moving "latest" copies, then the manifest that points at them.
    await rename(tmp, join(opts.dir, file));
    const latestTmp = join(opts.dir, '.gauntlet-latest.apk.tmp');
    await copyFile(join(opts.dir, file), latestTmp);
    await rename(latestTmp, join(opts.dir, 'gauntlet-latest.apk'));
    const release: AndroidRelease = {
      version: tag,
      builtAt: rel.published_at ?? new Date().toISOString(),
      sha256,
      file,
      sizeBytes: size,
    };
    const jsonTmp = join(opts.dir, '.latest.json.tmp');
    await writeFile(jsonTmp, JSON.stringify(release, null, 2));
    await rename(jsonTmp, join(opts.dir, 'latest.json'));

    // Older versioned APKs are only taking up space now.
    for (const name of await readdir(opts.dir)) {
      if (/^gauntlet-.+\.apk$/.test(name) && name !== file && name !== 'gauntlet-latest.apk')
        await rm(join(opts.dir, name), { force: true });
    }
    opts.log?.('Android release updated from GitHub', { version: tag, sizeBytes: size });
    return { status: 'updated', release };
  } finally {
    await rm(tmp, { force: true });
  }
}

async function isFile(path: string) {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

/** Check now, then every `minutes`. Returns a stop function. Failures are logged, never thrown. */
export function startReleaseMirror(
  opts: GithubReleaseOptions & {
    minutes: number;
    onError?: (err: unknown) => void;
  },
): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await mirrorLatestRelease(opts);
    } catch (err) {
      opts.onError?.(err);
    } finally {
      running = false;
    }
  };
  void run();
  const timer = opts.minutes > 0 ? setInterval(run, opts.minutes * 60_000) : null;
  timer?.unref();
  return () => {
    if (timer) clearInterval(timer);
  };
}
