/** Queries for the Stats screens: head to head, and workouts (server only; read live). */
import type { CompareResponse, WorkoutDetail, WorkoutsResponse } from '@gauntlet/shared';
import { useQuery } from '@tanstack/react-query';
import { ApiError, get } from './api';
import { session } from './session';

export const useCompare = (userId: string, range: 'day' | 'week' | 'month') =>
  useQuery({
    queryKey: ['compare', userId, range] as const,
    queryFn: () =>
      get<CompareResponse>(`/api/users/${encodeURIComponent(userId)}/compare?range=${range}`),
    enabled: !!userId && !session.direct,
    placeholderData: (prev) => prev,
  });

/** Your own workouts for the last 30 days. */
export const useWorkouts = (enabled = true) =>
  useQuery({
    queryKey: ['workouts', 30] as const,
    queryFn: () => get<WorkoutsResponse>('/api/me/workouts?days=30'),
    enabled: enabled && !session.direct,
    staleTime: 60_000,
  });

/** One workout; `ownerId` when it is someone else's (Show Events). */
export const useWorkout = (id: string, ownerId: string | null) =>
  useQuery({
    queryKey: ['workout', id, ownerId] as const,
    queryFn: () =>
      get<WorkoutDetail>(
        `/api/workouts/${encodeURIComponent(id)}${ownerId ? `?userId=${encodeURIComponent(ownerId)}` : ''}`,
      ),
    enabled: !!id && !session.direct,
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });

/** Where a workout opens. Someone else's carries their id so the server can check Show Events. */
export const workoutPath = (id: string, ownerId?: string | null) =>
  `/workouts/${encodeURIComponent(id)}${ownerId ? `?u=${encodeURIComponent(ownerId)}` : ''}`;
