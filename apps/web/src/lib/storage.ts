import { Preferences } from '@capacitor/preferences';
import { isNative } from './platform';

/** Small key-value store: Capacitor Preferences on Android, localStorage on the web. */
export const storage = {
  async get(key: string): Promise<string | null> {
    if (isNative) return (await Preferences.get({ key })).value;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  async set(key: string, value: string | null): Promise<void> {
    if (isNative) {
      if (value == null) await Preferences.remove({ key });
      else await Preferences.set({ key, value });
      return;
    }
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* private mode etc. */
    }
  },
};
