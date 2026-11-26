/** Queries for the month / year in review and the calendar heatmap. */
import type { HeatmapMetricKey, HeatmapResponse, Review, ReviewList } from '@gauntlet/shared';
import { useQuery } from '@tanstack/react-query';
import { ApiError, get } from './api';

export const reviewKeys = {
  list: ['reviews'] as const,
  one: (period: string) => ['review', period] as const,
  heatmap: (userId: string, metric: string) => ['heatmap', userId, metric] as const,
};

/** Which months and years have a review. */
export const useReviewList = (enabled = true) =>
  useQuery({
    queryKey: reviewKeys.list,
    enabled,
    queryFn: () => get<ReviewList>('/api/me/reviews'),
    staleTime: 5 * 60_000,
  });

export const useReview = (period: string, enabled = true) =>
  useQuery({
    queryKey: reviewKeys.one(period),
    enabled,
    queryFn: () => get<Review>(`/api/me/review/${period}`),
  });

export const useHeatmap = (userId: string, metric: HeatmapMetricKey) =>
  useQuery({
    queryKey: reviewKeys.heatmap(userId, metric),
    enabled: !!userId,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    queryFn: () =>
      get<HeatmapResponse>(`/api/users/${encodeURIComponent(userId)}/heatmap?metric=${metric}`),
  });
