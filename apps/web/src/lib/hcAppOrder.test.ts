import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HC_APP_ORDER_KEY, loadHcAppOrder, saveHcAppOrder } from './hcAppOrder';

let store: Record<string, string>;
beforeEach(() => {
  store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => void (store[k] = v),
    removeItem: (k: string) => void delete store[k],
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('the app choice kept on the phone (direct mode)', () => {
  it('starts with no filter', async () => {
    expect(await loadHcAppOrder()).toEqual({});
  });
  it('saves and loads, and clearing it removes it', async () => {
    await saveHcAppOrder({ steps: ['com.fitbit.FitbitMobile'], sleep: ['com.urbandroid.sleep'] });
    expect(await loadHcAppOrder()).toEqual({
      steps: ['com.fitbit.FitbitMobile'],
      sleep: ['com.urbandroid.sleep'],
    });
    await saveHcAppOrder({});
    expect(store[HC_APP_ORDER_KEY]).toBeUndefined();
    expect(await loadHcAppOrder()).toEqual({});
  });
  it('treats a damaged or unknown-stat value as no filter, and refuses to save one', async () => {
    store[HC_APP_ORDER_KEY] = '{not json';
    expect(await loadHcAppOrder()).toEqual({});
    store[HC_APP_ORDER_KEY] = JSON.stringify({ nonsense: ['x'] });
    expect(await loadHcAppOrder()).toEqual({});
    await expect(saveHcAppOrder({ nonsense: ['x'] })).rejects.toThrow();
  });
});
