import { describe, expect, it } from 'vitest';
import { RELOAD_COOLDOWN_MS, shouldReload } from './chunkReload';

describe('shouldReload', () => {
  it('reloads the first time', () => expect(shouldReload(1000, null)).toBe(true));
  it('does not loop', () => expect(shouldReload(1000 + 5000, 1000)).toBe(false));
  it('tries again after the cooldown', () =>
    expect(shouldReload(1000 + RELOAD_COOLDOWN_MS + 1, 1000)).toBe(true));
});
