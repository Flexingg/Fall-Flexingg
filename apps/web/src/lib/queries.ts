import type {
  ProfileResponse,
  AndroidRelease,
  ChallengeDetail,
  ChallengeEventsResponse,
  ChallengeProgress,
  ChallengeResult,
  ChallengeSummary,
  CustomMetricOption,
  FastStatus,
  LiftOption,
  DiscoverResponse,
  FeedEvent,
  FriendsResponse,
  MetricKey,
  SourcesResponse,
  TodayResponse,
  TrendsOverview,
  TrendsResponse,
  UserCard,
  WallpaperResponse,
} from '@gauntlet/shared';
import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { ApiError, get } from './api';
import { connections, garmin, session } from './session';
import { usePendingUndo } from './undo';

export const keys = {
  today: ['today'] as const,
  feed: ['feed'] as const,
  challenges: ['challenges'] as const,
  discover: ['discover'] as const,
  userSearch: (q: string) => ['user-search', q] as const,
  challenge: (id: string) => ['challenge', id] as const,
  progress: (id: string) => ['progress', id] as const,
  result: (id: string) => ['result', id] as const,
  friends: ['friends'] as const,
  trends: (range: string, metric: string) => ['trends', range, metric] as const,
  sources: ['sources'] as const,
  garmin: ['garmin'] as const,
  connections: ['connections'] as const,
  history: ['history-import'] as const,
  customMetrics: ['custom-metrics'] as const,
  lifts: ['lifts'] as const,
  fast: ['fast'] as const,
  androidRelease: ['android-release'] as const,
  profiles: ['profile'] as const,
  sourcePriority: ['source-priority'] as const,
  profile: (id: string) => ['profile', id] as const,
  wallpaper: ['wallpaper'] as const,
};

/** Numbers that move while you watch (today, a live challenge): look again every minute. */
const live = { refetchInterval: 60_000, refetchOnWindowFocus: true };
/** Lists that change slowly (feed, challenge list, friends): every few minutes and on coming back. */
const calm = { refetchInterval: 180_000, refetchOnWindowFocus: true };

// In direct mode (Android talking straight to SparkyFitness) these read from the phone; otherwise
// they ask the Gauntlet server. Switching modes clears the query cache, so the two never mix.
export const useToday = (enabled = true) =>
  useQuery({
    queryKey: keys.today,
    queryFn: () => (session.direct ? session.direct.today() : get<TodayResponse>('/api/me/today')),
    enabled,
    ...live,
  });
/** Today's food, water and lifting against goals: what the live wallpaper draws. */
export const useWallpaper = (enabled = true) =>
  useQuery({
    queryKey: keys.wallpaper,
    queryFn: () =>
      session.direct ? session.direct.wallpaper() : get<WallpaperResponse>('/api/me/wallpaper'),
    enabled,
    ...calm,
  });
export const useFeed = () =>
  useQuery({
    queryKey: keys.feed,
    queryFn: () => get<FeedEvent[]>('/api/feed?limit=20'),
    enabled: !session.direct,
    ...calm,
  });
export const useChallenges = (enabled = true) => {
  // A challenge you just left (still undoable) is already gone from the list.
  const waiting = usePendingUndo();
  return useQuery({
    queryKey: keys.challenges,
    queryFn: () => get<ChallengeSummary[]>('/api/challenges'),
    enabled,
    select: useCallback(
      (list: ChallengeSummary[]) => list.filter((c) => !waiting.has(`leave:${c.id}`)),
      [waiting],
    ),
    ...calm,
  });
};
export const useDiscover = (enabled = true) =>
  useQuery({
    queryKey: keys.discover,
    queryFn: () => get<DiscoverResponse>('/api/challenges/discover'),
    enabled: enabled && !session.direct,
    staleTime: 30_000,
  });
/** Public people matching a name or @handle. Needs at least two characters. */
export const useUserSearch = (q: string) =>
  useQuery({
    queryKey: keys.userSearch(q),
    queryFn: () => get<UserCard[]>(`/api/users/search?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length >= 2 && !session.direct,
    staleTime: 15_000,
  });
export const useChallenge = (id: string) =>
  useQuery({
    queryKey: keys.challenge(id),
    queryFn: () => get<ChallengeDetail>(`/api/challenges/${id}`),
    ...live,
  });
export const useProgress = (id: string) =>
  useQuery({
    queryKey: keys.progress(id),
    queryFn: () => get<ChallengeProgress>(`/api/challenges/${id}/progress`),
    enabled: !session.direct,
    ...live,
  });
/** What counted on one day (Show Events), read live from SparkyFitness. */
export const useEvents = (id: string, date: string, userId: string | null, enabled: boolean) =>
  useQuery({
    queryKey: ['events', id, date, userId] as const,
    queryFn: () =>
      get<ChallengeEventsResponse>(
        `/api/challenges/${id}/events?date=${date}${userId ? `&userId=${userId}` : ''}`,
      ),
    enabled: enabled && !session.direct,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
export const useResult = (id: string) =>
  useQuery({
    queryKey: keys.result(id),
    queryFn: () => get<ChallengeResult>(`/api/challenges/${id}/result`),
  });
export const useFriends = () => {
  // Someone you just unfriended (still undoable) is already gone from the crew.
  const waiting = usePendingUndo();
  return useQuery({
    queryKey: keys.friends,
    queryFn: () => get<FriendsResponse>('/api/friends'),
    select: useCallback(
      (d: FriendsResponse) => ({
        ...d,
        friends: d.friends.filter((f) => !waiting.has(`unfriend:${f.id}`)),
      }),
      [waiting],
    ),
    ...calm,
  });
};
export const useTrendsOverview = (range: 'day' | 'week' | 'month') =>
  useQuery({
    queryKey: ['trends-overview', range] as const,
    queryFn: () =>
      session.direct
        ? session.direct.trendsOverview(range)
        : get<TrendsOverview>(`/api/me/trends/overview?range=${range}`),
  });
export const useTrends = (range: 'day' | 'week' | 'month', metric: string) =>
  useQuery({
    queryKey: keys.trends(range, metric),
    queryFn: () =>
      session.direct
        ? session.direct.trends(range, metric)
        : get<TrendsResponse>(`/api/me/trends?range=${range}&metric=${encodeURIComponent(metric)}`),
  });
export const useSources = () =>
  useQuery({
    queryKey: keys.sources,
    queryFn: () =>
      session.direct ? session.direct.sources() : get<SourcesResponse>('/api/sources'),
  });
export const useCustomMetrics = (enabled: boolean) =>
  useQuery({
    queryKey: keys.customMetrics,
    queryFn: () => get<CustomMetricOption[]>('/api/me/custom-metrics'),
    enabled: enabled && !session.direct,
    staleTime: 300_000,
  });

/** Null when this server doesn't host an APK. */
export const useAndroidRelease = (enabled: boolean) =>
  useQuery({
    queryKey: keys.androidRelease,
    enabled,
    staleTime: 300_000,
    retry: false,
    queryFn: async () => {
      try {
        return await get<AndroidRelease>('/api/app/android');
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  });

export const useGarmin = () =>
  useQuery({ queryKey: keys.garmin, queryFn: () => garmin.status(), staleTime: 30_000 });

export const useConnections = () =>
  useQuery({ queryKey: keys.connections, queryFn: () => connections.list(), staleTime: 15_000 });

/** Exercises with weighted sets, for per-exercise strength challenges (server mode). */
export const useLifts = (enabled: boolean) =>
  useQuery({
    queryKey: keys.lifts,
    queryFn: () => get<LiftOption[]>('/api/me/lifts'),
    enabled: enabled && !session.direct,
    staleTime: 300_000,
  });

/** SparkyFitness' fasting tracker. */
export const useFast = (enabled: boolean) =>
  useQuery({
    queryKey: keys.fast,
    queryFn: () => get<FastStatus>('/api/me/fast'),
    enabled: enabled && !session.direct,
    refetchInterval: 300_000,
  });

/** Someone's profile, or your own (needs a Gauntlet server). */
export const useProfile = (id: string) =>
  useQuery({
    queryKey: keys.profile(id),
    enabled: !!id,
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
    queryFn: () => get<ProfileResponse>(`/api/users/${encodeURIComponent(id)}/profile`),
  });
