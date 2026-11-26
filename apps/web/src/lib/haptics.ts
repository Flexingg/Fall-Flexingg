/**
 * Small vibration cues for the Android app (a light tap, a firm thump, a "nice" buzz). They do
 * nothing on the web, and nothing when the person turned Vibration off in their settings.
 * Reduced motion doesn't switch them off: it is about movement on screen, not touch feedback.
 */
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { isNative } from './platform';
import { storage } from './storage';

const KEY = 'gauntlet.vibration';
let enabled = true;
let loaded: Promise<void> | null = null;

/** Read the saved switch once (on by default). */
export function loadVibration(): Promise<boolean> {
  loaded ??= storage
    .get(KEY)
    .then((v) => {
      enabled = v !== '0';
    })
    .catch(() => undefined);
  return loaded.then(() => enabled);
}

export function setVibration(on: boolean): Promise<void> {
  enabled = on;
  loaded = Promise.resolve();
  return storage.set(KEY, on ? null : '0');
}

if (isNative) void loadVibration();

function run(fn: () => Promise<void>) {
  if (!isNative || !enabled) return;
  fn().catch(() => undefined);
}

/** A light tap: reacting, pulling to refresh. */
export const tap = () => run(() => Haptics.impact({ style: ImpactStyle.Light }));
/** A firm thump: THROW IT DOWN landing. */
export const impact = () => run(() => Haptics.impact({ style: ImpactStyle.Heavy }));
/** The good kind of buzz: you took the lead, your rank went up. */
export const success = () => run(() => Haptics.notification({ type: NotificationType.Success }));
