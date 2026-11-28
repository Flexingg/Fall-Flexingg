/** Queries for notifications, push setup and the weekly recap. */
import type {
  NotificationPrefsResponse,
  NotificationsPage,
  PushConfig,
  WeeklyRecap,
} from '@gauntlet/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { get } from './api';

export const notifyKeys = {
  list: ['notifications'] as const,
  unread: ['notifications-unread'] as const,
  prefs: ['notification-prefs'] as const,
  pushConfig: ['push-config'] as const,
  recap: (week: string) => ['recap', week] as const,
};

/** The number on the bell. Refreshed every two minutes and when the app comes back to the front. */
export const useUnreadCount = (enabled = true) =>
  useQuery({
    queryKey: notifyKeys.unread,
    queryFn: () => get<{ count: number }>('/api/notifications/unread-count'),
    enabled,
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
  });

export const useNotifications = () =>
  useInfiniteQuery({
    queryKey: notifyKeys.list,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      get<NotificationsPage>(
        `/api/notifications${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (last) => last.nextBefore,
    refetchOnWindowFocus: true,
  });

export const useNotificationPrefs = () =>
  useQuery({
    queryKey: notifyKeys.prefs,
    queryFn: () => get<NotificationPrefsResponse>('/api/me/notification-prefs'),
  });

export const usePushConfig = () =>
  useQuery({
    queryKey: notifyKeys.pushConfig,
    queryFn: () => get<PushConfig>('/api/push/config'),
    staleTime: 5 * 60_000,
  });

export const useRecap = (week: string) =>
  useQuery({
    queryKey: notifyKeys.recap(week),
    queryFn: () => get<WeeklyRecap>(`/api/me/recap/${week}`),
  });
