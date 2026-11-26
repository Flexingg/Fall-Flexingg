/**
 * Which way the app is talking: straight to SparkyFitness ("direct", Android only) or through a
 * Gauntlet server ("server", the web app and the full Android app). One place decides, so screens
 * just call these helpers.
 */
import type {
  SyncResponse,
  ConnectionInfo,
  ConnectionsResponse,
  ConnectResult,
  GarminLoginResult,
  GarminStatus,
  MeUser,
  ProviderId,
  UserSettings,
} from '@gauntlet/shared';
import { DirectBackend } from './direct/DirectBackend';
import { secret } from './direct/secret';
import { get, post, patch } from './api';
import { deviceLocale, timezone } from './platform';
import { storage } from './storage';
import { publishWallpaper } from './wallpaper';

export type Mode = 'direct' | 'server';

const MODE_KEY = 'gauntlet.mode';
const SPARKY_URL_KEY = 'gauntlet.sparky.url';
const SERVER_URL_KEY = 'gauntlet.server.url';

export interface StoredSession {
  mode: Mode | null;
  sparkyUrl: string | null;
  serverUrl: string | null;
}

export const session: { direct: DirectBackend | null } = { direct: null };

export async function loadStored(): Promise<StoredSession> {
  const mode = (await storage.get(MODE_KEY)) as Mode | null;
  return {
    mode: mode === 'direct' || mode === 'server' ? mode : null,
    sparkyUrl: await storage.get(SPARKY_URL_KEY),
    serverUrl: await storage.get(SERVER_URL_KEY),
  };
}

export async function saveStored(s: Partial<StoredSession>) {
  if (s.mode !== undefined) await storage.set(MODE_KEY, s.mode);
  if (s.sparkyUrl !== undefined) await storage.set(SPARKY_URL_KEY, s.sparkyUrl);
  if (s.serverUrl !== undefined) await storage.set(SERVER_URL_KEY, s.serverUrl);
}

export async function clearStored() {
  session.direct = null;
  await Promise.all([
    saveStored({ mode: null, sparkyUrl: null, serverUrl: null }),
    secret.remove(),
    clearDirectCaches(),
    // Signed out: the live wallpaper goes back to an empty galaxy.
    publishWallpaper(null),
  ]);
}

async function clearDirectCaches() {
  for (const k of ['gauntlet.direct.rows', 'gauntlet.direct.me', 'gauntlet.direct.settings'])
    await storage.set(k, null);
}

export function makeDirect(sparkyUrl: string, apiKey: string): DirectBackend {
  return new DirectBackend({ sparkyUrl, apiKey, kv: storage, timezone, locale: deviceLocale });
}

export const cleanUrl = (u: string) => u.trim().replace(/\/+$/, '');

/**
 * Pull fresh data now. With `providers`, the server also asks each connected app to pull its
 * latest (direct mode re-reads SparkyFitness only).
 */
export async function syncNow(opts: { providers?: boolean } = {}): Promise<SyncResponse> {
  if (session.direct) return { ...(await session.direct.sync()), pulling: [] };
  return post<SyncResponse>('/api/me/sync', opts);
}

/** Save profile settings. In direct mode they live on the phone. */
export async function updateSettings(settings: Partial<UserSettings>): Promise<MeUser> {
  if (session.direct) return session.direct.updateSettings(settings);
  return patch<MeUser>('/api/me', { settings });
}

/** Send Health Connect records to SparkyFitness, directly or through the Gauntlet server. */
export async function sendHealthRecords(records: Record<string, unknown>[]): Promise<void> {
  if (session.direct) await session.direct.ingest(records);
  else await post('/api/ingest/health-connect', { records });
}

/** Garmin Connect, linked inside SparkyFitness. Same calls whether or not a Gauntlet server is in between. */
export const garmin = {
  status: (): Promise<GarminStatus> =>
    session.direct ? session.direct.garminStatus() : get<GarminStatus>('/api/garmin'),
  login: (email: string, password: string): Promise<GarminLoginResult> =>
    session.direct
      ? session.direct.garminLogin(email, password)
      : post<GarminLoginResult>('/api/garmin/login', { email, password }),
  mfa: (clientState: string, code: string): Promise<GarminLoginResult> =>
    session.direct
      ? session.direct.garminMfa(clientState, code)
      : post<GarminLoginResult>('/api/garmin/login/mfa', { clientState, code }),
  sync: (): Promise<{ ok: true }> =>
    session.direct ? session.direct.garminSync() : post<{ ok: true }>('/api/garmin/sync', {}),
  disconnect: (): Promise<{ ok: true }> =>
    session.direct
      ? session.direct.garminDisconnect()
      : post<{ ok: true }>('/api/garmin/disconnect', {}),
};

/** Every other app and device (and Garmin's sync/disconnect), the same way in both modes. */
export const connections = {
  list: async (): Promise<ConnectionInfo[]> =>
    session.direct
      ? session.direct.connections()
      : (await get<ConnectionsResponse>('/api/connections')).connections,
  connect: (id: ProviderId, apiKey?: string): Promise<ConnectResult> =>
    session.direct
      ? session.direct.connect(id, { apiKey })
      : post<ConnectResult>(`/api/connections/${id}/connect`, apiKey ? { apiKey } : {}),
  /** The provider sent the person back with a code (server mode only). */
  finishOAuth: (id: ProviderId, code: string, state?: string): Promise<ConnectResult> =>
    post<ConnectResult>(`/api/connections/${id}/oauth`, { code, ...(state ? { state } : {}) }),
  sync: (id: ProviderId): Promise<{ ok: true }> =>
    session.direct
      ? session.direct.syncApp(id)
      : post<{ ok: true }>(`/api/connections/${id}/sync`, {}),
  disconnect: (id: ProviderId): Promise<{ ok: true }> =>
    session.direct
      ? session.direct.disconnect(id)
      : post<{ ok: true }>(`/api/connections/${id}/disconnect`, {}),
};
