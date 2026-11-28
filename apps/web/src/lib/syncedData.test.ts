import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { invalidateSyncedData, isSyncedKey } from './syncedData';

describe('isSyncedKey', () => {
  it('covers numbers, standings and feeds', () => {
    for (const k of [
      ['today'],
      ['day', '2026-01-01'],
      ['feed'],
      ['challenge', 'x'],
      ['badges', 'summary'],
    ])
      expect(isSyncedKey(k)).toBe(true);
  });
  it('leaves settings, admin and setup data alone', () => {
    for (const k of [
      ['admin', 'x'],
      ['rings'],
      ['push-config'],
      ['notification-prefs'],
      ['hc-apps'],
      ['lifts'],
      ['source-priority'],
      [],
    ])
      expect(isSyncedKey(k)).toBe(false);
  });
});

describe('invalidateSyncedData', () => {
  it('marks only synced queries stale', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['today'], 1);
    qc.setQueryData(['rings'], 2);
    await invalidateSyncedData(qc);
    expect(qc.getQueryState(['today'])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['rings'])?.isInvalidated).toBe(false);
  });
});
