import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';

/** What the deploy script writes next to the APK. */
export interface AndroidRelease {
  version: string;
  builtAt: string;
  sha256: string;
  /** File name inside the downloads directory. */
  file: string;
  sizeBytes: number;
}

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(apk|json)$/;

export async function readAndroidRelease(dir: string): Promise<AndroidRelease | null> {
  try {
    const raw = JSON.parse(
      await readFile(join(dir, 'latest.json'), 'utf8'),
    ) as Partial<AndroidRelease>;
    if (!raw.version || !raw.file || !FILE_RE.test(raw.file)) return null;
    return {
      version: String(raw.version),
      builtAt: String(raw.builtAt ?? ''),
      sha256: String(raw.sha256 ?? ''),
      file: raw.file,
      sizeBytes: Number(raw.sizeBytes ?? 0),
    };
  } catch {
    return null;
  }
}

/** Serve released APKs, plus App Links verification so invite links open the app. */
export function downloadRoutes(app: FastifyInstance, cfg: Config) {
  const dir = cfg.DOWNLOADS_DIR;

  if (cfg.ASSETLINKS_SHA256) {
    app.get('/.well-known/assetlinks.json', async (_req, reply) => {
      reply.header('Cache-Control', 'public, max-age=3600');
      return [
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: {
            namespace: 'android_app',
            package_name: 'cc.randalls.gauntlet',
            sha256_cert_fingerprints: cfg.ASSETLINKS_SHA256.split(',')
              .map((f) => f.trim())
              .filter(Boolean),
          },
        },
      ];
    });
  }

  if (!dir) return;

  app.get('/api/app/android', async (_req, reply) => {
    const release = await readAndroidRelease(dir);
    if (!release)
      return reply
        .code(404)
        .send({ error: 'No Android build has been published yet', code: 'no_release' });
    reply.header('Cache-Control', 'no-cache');
    return {
      ...release,
      url: `/downloads/${release.file}`,
      latestUrl: '/downloads/gauntlet-latest.apk',
    };
  });

  app.get<{ Params: { file: string } }>('/downloads/:file', async (req, reply) => {
    const name = req.params.file;
    if (!FILE_RE.test(name)) return reply.code(404).send({ error: 'Not found', code: 'not_found' });
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return reply.code(404).send({ error: 'Not found', code: 'not_found' });
    const isApk = name.endsWith('.apk');
    reply
      .header(
        'Content-Type',
        isApk ? 'application/vnd.android.package-archive' : 'application/json',
      )
      .header('Content-Length', info.size)
      // The "latest" names move; versioned files never change.
      .header(
        'Cache-Control',
        name.includes('latest') ? 'no-cache' : 'public, max-age=31536000, immutable',
      );
    if (isApk) reply.header('Content-Disposition', `attachment; filename="${name}"`);
    return reply.send(createReadStream(path));
  });
}
