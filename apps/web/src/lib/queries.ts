import type {
  AndroidRelease,
  ChallengeDetail,
  ChallengeResult,
  ChallengeSummary,
  CustomMetricOption,
  FeedEvent,
  FriendsResponse,
  MetricKey,
  SourcesResponse,
  TodayResponse,
  TrendsResponse,
} from '@gauntlet/shared';
import { useQuery } from '@tanstack/react-query';
import { ApiError, get } from './api';
import { session } from './session';

export const keys = {
  today: ['today'] as const,
  feed: ['feed'] as const,
  challenges: ['challenges'] as const,
  challenge: (id: string) => ['challenge', id] as const,
  result: (id: string) => ['result', id] as const,
  friends: ['friends'] as const,
  trends: (range: string, metric: string) => ['trends', range, metric] as const,
  sources: ['sources'] as const,
  customMetrics: ['custom-metrics'] as const,
  androidRelease: ['android-release'] as const,
};

const live = { refetchInterval: 60_000, refetchOnWindowFocus: true };

// In direct mode (Android talking straight to SparkyFitness) these read from the phone; otherwise
// they ask the Gauntlet server. Switching modes clears the query cache, so the two never mix.
export const useToday = () =>
  useQuery({
    queryKey: keys.today,
    queryFn: () => (session.direct ? session.direct.today() : get<TodayResponse>('/api/me/today')),
    ...live,
  });
export const useFeed = () =>
  useQuery({
    queryKey: keys.feed,
    queryFn: () => get<FeedEvent[]>('/api/feed?limit=20'),
    enabled: !session.direct,
    ...live,
  });
export const useChallenges = () =>
  useQuery({
    queryKey: keys.challenges,
    queryFn: () => get<ChallengeSummary[]>('/api/challenges'),
    ...live,
  });
export const useChallenge = (id: string) =>
  useQuery({
    queryKey: keys.challenge(id),
    queryFn: () => get<ChallengeDetail>(`/api/challenges/${id}`),
    ...live,
  });
export const useResult = (id: string) =>
  useQuery({
    queryKey: keys.result(id),
    queryFn: () => get<ChallengeResult>(`/api/challenges/${id}/result`),
  });
export const useFriends = () =>
  useQuery({
    queryKey: keys.friends,
    queryFn: () => get<FriendsResponse>('/api/friends'),
    ...live,
  });
export const useTrends = (range: 'day' | 'week' | 'month', metric: MetricKey) =>
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
