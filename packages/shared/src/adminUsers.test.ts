import { describe, expect, it } from 'vitest';
import {
  accountTags,
  expiredReason,
  isExpired,
  quietDays,
  scheduledOn,
  type AccountFacts,
} from './adminUsers.js';

const NOW = new Date('2026-11-27T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const base: AccountFacts = {
  isDemo: false,
  isAdmin: false,
  keyStatus: 'active',
  lastSyncedAt: daysAgo(1),
  lastActiveAt: daysAgo(1),
  createdAt: daysAgo(400),
};

describe('expired accounts', () => {
  it('a recently used, healthy account is not expired', () => {
    expect(isExpired(base, NOW)).toBe(false);
  });

  it('lost SparkyFitness connection + 30 days quiet is expired; 29 is not', () => {
    const lost = { ...base, keyStatus: 'invalid' as const };
    expect(isExpired({ ...lost, lastActiveAt: daysAgo(29) }, NOW)).toBe(false);
    expect(isExpired({ ...lost, lastActiveAt: daysAgo(30) }, NOW)).toBe(true);
    expect(isExpired({ ...lost, keyStatus: 'revoked', lastActiveAt: daysAgo(45) }, NOW)).toBe(true);
  });

  it('never synced + 30 days quiet is expired', () => {
    const never = { ...base, lastSyncedAt: null };
    expect(isExpired({ ...never, lastActiveAt: daysAgo(10) }, NOW)).toBe(false);
    expect(isExpired({ ...never, lastActiveAt: daysAgo(31) }, NOW)).toBe(true);
  });

  it('healthy but unused for 180 days is expired; 179 is not', () => {
    expect(isExpired({ ...base, lastActiveAt: daysAgo(179) }, NOW)).toBe(false);
    expect(isExpired({ ...base, lastActiveAt: daysAgo(180) }, NOW)).toBe(true);
  });

  it('syncing fine and 100 days quiet is not expired', () => {
    expect(isExpired({ ...base, lastActiveAt: daysAgo(100) }, NOW)).toBe(false);
  });

  it('never used counts from sign-up', () => {
    const f = { ...base, lastActiveAt: null, lastSyncedAt: null };
    expect(quietDays({ ...f, createdAt: daysAgo(40) }, NOW)).toBe(40);
    expect(isExpired({ ...f, createdAt: daysAgo(40) }, NOW)).toBe(true);
    expect(isExpired({ ...f, createdAt: daysAgo(5) }, NOW)).toBe(false);
  });

  it('demo and admin accounts are never expired', () => {
    const old = { ...base, lastActiveAt: daysAgo(999), keyStatus: 'invalid' as const };
    expect(isExpired({ ...old, isDemo: true }, NOW)).toBe(false);
    expect(isExpired({ ...old, isAdmin: true }, NOW)).toBe(false);
    expect(expiredReason(old, NOW)).toMatch(/180/);
  });

  it('tags', () => {
    const tags = accountTags(
      {
        ...base,
        lastActiveAt: daysAgo(200),
        lastSyncError: 'boom',
        deletionScheduledAt: daysAgo(-5),
      },
      NOW,
    );
    expect(tags).toEqual(
      expect.arrayContaining(['scheduled', 'expired', 'inactive', 'sync_problem']),
    );
    expect(tags).not.toContain('active');
  });

  it('scheduledOn is 30 days before the deletion date', () => {
    expect(scheduledOn('2026-12-27T00:00:00Z').toISOString()).toBe('2026-11-27T00:00:00.000Z');
  });
});
