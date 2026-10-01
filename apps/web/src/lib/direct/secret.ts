import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { isNative } from '../platform';

const NAME = 'gauntlet.sparky.key';

/**
 * Where the SparkyFitness API key lives. On Android it is encrypted with a key held in the Android
 * Keystore. The browser fallback exists only for the opt-in test build and is not a secure store.
 */
export const secret = {
  async get(): Promise<string | null> {
    if (isNative) return SecureStorage.getItem(NAME);
    try {
      return localStorage.getItem(NAME);
    } catch {
      return null;
    }
  },
  async set(value: string): Promise<void> {
    if (isNative) return SecureStorage.setItem(NAME, value);
    localStorage.setItem(NAME, value);
  },
  async remove(): Promise<void> {
    if (isNative) {
      await SecureStorage.removeItem(NAME).catch(() => undefined);
      return;
    }
    try {
      localStorage.removeItem(NAME);
    } catch {
      /* ignore */
    }
  },
};
