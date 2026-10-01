import type { LoginResponse, RefreshResponse } from '@gauntlet/shared';
import { API_BASE, isNative, timezone } from './platform';
import { storage } from './storage';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

const REFRESH_KEY = 'gauntlet.refresh';

/** Where the Gauntlet API lives. Fixed for the web app; on Android the user can set it. */
let apiBase = API_BASE;
export const getApiBase = () => apiBase;
export function setApiBase(url: string) {
  apiBase = url.replace(/\/+$/, '');
  accessToken = null;
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const signedOutListeners = new Set<() => void>();

export function onSignedOut(fn: () => void) {
  signedOutListeners.add(fn);
  return () => signedOutListeners.delete(fn);
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { 'X-Timezone': timezone, ...extra };
  if (isNative) h['X-Gauntlet-Client'] = 'native';
  if (accessToken) h.Authorization = `Bearer ${accessToken}`;
  return h;
}

async function raw(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  try {
    return await fetch(`${apiBase}${path}`, {
      ...rest,
      credentials: 'include',
      headers: headers(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError("Can't reach Gauntlet. Check your connection.", 0, 'offline');
  }
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok)
    throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status, body?.code);
  return body as T;
}

/** Use the refresh token (cookie on web, stored token on Android) to get a new access token. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const stored = isNative ? await storage.get(REFRESH_KEY) : null;
      if (isNative && !stored) return false;
      const res = await raw('/api/auth/refresh', {
        method: 'POST',
        json: stored ? { refreshToken: stored } : {},
      });
      if (!res.ok) {
        if (res.status === 401) await clearSession();
        return false;
      }
      await adoptTokens(await res.json());
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function adoptTokens(t: RefreshResponse) {
  accessToken = t.accessToken;
  if (t.refreshToken) await storage.set(REFRESH_KEY, t.refreshToken);
}

async function clearSession() {
  accessToken = null;
  await storage.set(REFRESH_KEY, null);
}

export async function api<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  if (!accessToken) await refreshSession();
  let res = await raw(path, init);
  if (res.status === 401) {
    if (await refreshSession()) res = await raw(path, init);
    else signedOutListeners.forEach((fn) => fn());
  }
  return parse<T>(res);
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, json: unknown = {}) => api<T>(path, { method: 'POST', json });
export const patch = <T>(path: string, json: unknown) => api<T>(path, { method: 'PATCH', json });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

export async function login(
  path: '/api/auth/login' | '/api/auth/login/2fa' | '/api/auth/signup',
  body: unknown,
): Promise<LoginResponse> {
  const res = await raw(path, { method: 'POST', json: body });
  const data = await parse<LoginResponse>(res);
  if (data.status === 'ok') await adoptTokens(data);
  return data;
}

export async function logout() {
  const stored = isNative ? await storage.get(REFRESH_KEY) : null;
  await raw('/api/auth/logout', {
    method: 'POST',
    json: stored ? { refreshToken: stored } : {},
  }).catch(() => undefined);
  await clearSession();
}

/** Public endpoints (invite previews) that work signed out. */
export async function publicGet<T>(path: string): Promise<T> {
  return parse<T>(await raw(path));
}
