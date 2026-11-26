/**
 * Turning notifications on for this device, with no outside service:
 *  - Browsers and the installed web app use Web Push, signed by the Gauntlet server's own keys.
 *  - The Android app has no Google services to receive pushes with, so a small background job
 *    (GauntletPush plugin) asks the Gauntlet server for new notifications every ~15 minutes.
 */
import { registerPlugin } from '@capacitor/core';
import { api, getApiBase, post } from './api';
import { isNative, platform } from './platform';

// ---------- Android app ----------

interface GauntletPushPlugin {
  status(): Promise<{ enabled: boolean; permission: 'granted' | 'denied' | 'prompt' }>;
  /** Asks for the Android 13+ notification permission (granted at once on older versions). */
  requestPermission(): Promise<{ granted: boolean }>;
  /** Saves the server and device token on the phone and starts the background job. */
  enable(opts: { serverUrl: string; token: string }): Promise<void>;
  /** Stops the job and forgets the token; returns it so the server can drop the device. */
  disable(): Promise<{ token: string | null }>;
}
const GauntletPush = registerPlugin<GauntletPushPlugin>('GauntletPush');

export const hasNativePush = isNative && platform === 'android';

export async function nativePushStatus(): Promise<{ enabled: boolean; blocked: boolean }> {
  const s = await GauntletPush.status();
  return { enabled: s.enabled, blocked: s.permission === 'denied' };
}

/** Returns false when the person said no to Android's permission prompt. */
export async function enableNativePush(): Promise<boolean> {
  const { granted } = await GauntletPush.requestPermission();
  if (!granted) return false;
  const { token } = await post<{ token: string }>('/api/push/device', { label: 'Android app' });
  await GauntletPush.enable({ serverUrl: getApiBase(), token });
  return true;
}

export async function disableNativePush(): Promise<void> {
  const { token } = await GauntletPush.disable();
  if (token) await post('/api/push/device/revoke', { token }).catch(() => undefined);
}

/** Sign-out: stop phone notifications for this account (best effort, never blocks signing out). */
export async function stopNativePushOnSignOut(): Promise<void> {
  if (!hasNativePush) return;
  await disableNativePush().catch(() => undefined);
}

// ---------- Browsers ----------

export const webPushSupported =
  !isNative &&
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  typeof window !== 'undefined' &&
  'PushManager' in window &&
  'Notification' in window;

function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url + '='.repeat((4 - (base64Url.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration() {
  return navigator.serviceWorker.ready;
}

export async function webPushSubscribed(): Promise<boolean> {
  if (!webPushSupported) return false;
  const sub = await (await registration()).pushManager.getSubscription();
  return !!sub && Notification.permission === 'granted';
}

export function webPushBlocked(): boolean {
  return webPushSupported && Notification.permission === 'denied';
}

/** Returns false when the person said no to the browser's permission prompt. */
export async function enableWebPush(publicKey: string): Promise<boolean> {
  if (
    Notification.permission !== 'granted' &&
    (await Notification.requestPermission()) !== 'granted'
  )
    return false;
  const reg = await registration();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    }));
  await post('/api/push/webpush', {
    subscription: sub.toJSON(),
    label: navigator.userAgent.slice(0, 60),
  });
  return true;
}

export async function disableWebPush(): Promise<void> {
  const sub = await (await registration()).pushManager.getSubscription();
  if (!sub) return;
  await api('/api/push/webpush', { method: 'DELETE', json: { endpoint: sub.endpoint } }).catch(
    () => undefined,
  );
  await sub.unsubscribe();
}
