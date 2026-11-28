/**
 * Which cached queries a sync (or a change that moves everyone's numbers) can make out of date.
 * `qc.invalidateQueries()` with no key also touches settings, admin tools, the push setup and other
 * data a sync never changes, and the caller waits for every one that is on screen. This lists the
 * data that can move; the rest is left alone. Only queries on screen are fetched again, the rest are
 * just marked stale and read fresh the next time they are opened.
 */
import type { QueryClient, QueryKey } from '@tanstack/react-query';

/** The first part of each query key that holds numbers, standings or feed items. */
export const SYNCED_ROOTS: ReadonlySet<string> = new Set([
  'today',
  'day',
  'wallpaper',
  'feed',
  'challenges',
  'challenge',
  'progress',
  'events',
  'result',
  'friends',
  'profile',
  'trends',
  'trends-overview',
  'sources',
  'fast',
  'badges',
  'notifications',
  'notifications-unread',
  'compare',
  'workouts',
  'workout',
  'statSource',
  'heatmap',
  'reviews',
  'review',
  'recap',
  // Lists a change (a friend request, a joined challenge) moves.
  'user-search',
  'discover',
  'invite',
]);

export const isSyncedKey = (key: QueryKey): boolean =>
  typeof key[0] === 'string' && SYNCED_ROOTS.has(key[0]);

/** Mark everything a sync can change as stale, and fetch again what is on screen. */
export function invalidateSyncedData(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({
    predicate: (q) => isSyncedKey(q.queryKey),
    refetchType: 'active',
  });
}
