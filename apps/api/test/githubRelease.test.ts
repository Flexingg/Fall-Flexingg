import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mirrorLatestRelease } from '../src/githubRelease.js';

const apkV1 = Buffer.from('PK\x03\x04 version one');
const apkV2 = Buffer.from('PK\x03\x04 version two, a bit longer');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A stand-in for api.github.com serving one release; records what was asked for. */
function fakeGithub(tag: string, apk: Buffer, opts: { sum?: string; status?: number } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.endsWith('/releases/latest')) {
      if (opts.status) return new Response('{}', { status: opts.status });
      return Response.json({
        tag_name: tag,
        published_at: '2026-11-20T10:00:00Z',
        draft: false,
        prerelease: false,
        assets: [
          { id: 1, name: `gauntlet-${tag}.aab`, size: 9, url: 'https://gh.test/assets/1' },
          { id: 2, name: `gauntlet-${tag}.apk`, size: apk.length, url: 'https://gh.test/assets/2' },
          { id: 3, name: `gauntlet-${tag}.apk.sha256`, size: 80, url: 'https://gh.test/assets/3' },
        ],
      });
    }
    if (url.endsWith('/assets/2')) return new Response(apk);
    if (url.endsWith('/assets/3'))
      return new Response(`${opts.sum ?? sha(apk)}  gauntlet-${tag}.apk\n`);
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe('GitHub release mirror', () => {
  it('downloads the APK, checks its checksum and writes latest.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gauntlet-gh-'));
    const gh = fakeGithub('v1.0.0', apkV1);
    const res = await mirrorLatestRelease({
      repo: 'me/app',
      token: 'tok',
      dir,
      fetch: gh.fetchFn,
    });
    expect(res.status).toBe('updated');
    expect(readFileSync(join(dir, 'gauntlet-v1.0.0.apk')).equals(apkV1)).toBe(true);
    expect(readFileSync(join(dir, 'gauntlet-latest.apk')).equals(apkV1)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'))).toEqual({
      version: 'v1.0.0',
      builtAt: '2026-11-20T10:00:00Z',
      sha256: sha(apkV1),
      file: 'gauntlet-v1.0.0.apk',
      sizeBytes: apkV1.length,
    });
    // Private repositories: the token goes with every request, and assets are asked for as bytes.
    expect(gh.calls[0]!.url).toBe('https://api.github.com/repos/me/app/releases/latest');
    expect(gh.calls.every((c) => c.headers.Authorization === 'Bearer tok')).toBe(true);
    expect(gh.calls.find((c) => c.url.endsWith('/assets/2'))!.headers.Accept).toBe(
      'application/octet-stream',
    );
    // The .aab is never fetched.
    expect(gh.calls.some((c) => c.url.endsWith('/assets/1'))).toBe(false);
  });

  it('does nothing when it already has that release', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gauntlet-gh-'));
    await mirrorLatestRelease({ repo: 'me/app', dir, fetch: fakeGithub('v1.0.0', apkV1).fetchFn });
    const again = fakeGithub('v1.0.0', apkV1);
    const res = await mirrorLatestRelease({ repo: 'me/app', dir, fetch: again.fetchFn });
    expect(res.status).toBe('current');
    expect(again.calls).toHaveLength(1);
  });

  it('replaces an older release and removes its APK', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gauntlet-gh-'));
    await mirrorLatestRelease({ repo: 'me/app', dir, fetch: fakeGithub('v1.0.0', apkV1).fetchFn });
    const res = await mirrorLatestRelease({
      repo: 'me/app',
      dir,
      fetch: fakeGithub('v1.1.0', apkV2).fetchFn,
    });
    expect(res.status).toBe('updated');
    expect(existsSync(join(dir, 'gauntlet-v1.0.0.apk'))).toBe(false);
    expect(readFileSync(join(dir, 'gauntlet-latest.apk')).equals(apkV2)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')).version).toBe('v1.1.0');
  });

  it('keeps the current release when the download does not match its checksum', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gauntlet-gh-'));
    await mirrorLatestRelease({ repo: 'me/app', dir, fetch: fakeGithub('v1.0.0', apkV1).fetchFn });
    await expect(
      mirrorLatestRelease({
        repo: 'me/app',
        dir,
        fetch: fakeGithub('v1.1.0', apkV2, { sum: 'f'.repeat(64) }).fetchFn,
      }),
    ).rejects.toThrow(/checksum mismatch/);
    expect(JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')).version).toBe('v1.0.0');
    expect(readFileSync(join(dir, 'gauntlet-latest.apk')).equals(apkV1)).toBe(true);
    expect(existsSync(join(dir, 'gauntlet-v1.1.0.apk'))).toBe(false);
  });

  it('explains a 404 from a private repository without a token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gauntlet-gh-'));
    writeFileSync(join(dir, 'keep.txt'), 'x');
    await expect(
      mirrorLatestRelease({
        repo: 'me/app',
        dir,
        fetch: fakeGithub('v1.0.0', apkV1, { status: 404 }).fetchFn,
      }),
    ).rejects.toThrow(/needs GITHUB_TOKEN/);
  });
});
