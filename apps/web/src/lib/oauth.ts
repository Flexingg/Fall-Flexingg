import type { ProviderId } from '@gauntlet/shared';
import { isNative } from './platform';
import { storage } from './storage';

const KEY = 'gauntlet.oauth.pending';
const MAX_AGE_MS = 15 * 60_000;

/** Remember that this device started connecting an app, so a link someone else sends can't finish it. */
export async function rememberOAuthStart(id: ProviderId) {
  await storage.set(KEY, JSON.stringify({ id, at: Date.now() }));
}

export async function startedHere(id: ProviderId): Promise<boolean> {
  try {
    const raw = await storage.get(KEY);
    if (!raw) return false;
    const p = JSON.parse(raw) as { id?: string; at?: number };
    return p.id === id && typeof p.at === 'number' && Date.now() - p.at < MAX_AGE_MS;
  } catch {
    return false;
  }
}

export const forgetOAuthStart = () => storage.set(KEY, null);

/**
 * Send the person to the app's own sign-in page. In a browser the page itself goes there and comes
 * back; on Android the system browser opens, and the return link opens this app again.
 */
export function openSignIn(url: string) {
  if (isNative) window.open(url, '_blank');
  else window.location.assign(url);
}
