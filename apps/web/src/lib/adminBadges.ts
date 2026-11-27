/** Admin → Badges data: the badge list, Garmin-idea suggestions and the import status. */
import type {
  AdminBadge,
  BadgeImportStatus,
  BadgeSuggestion,
  SuggestionStatus,
} from '@gauntlet/shared';
import { useQuery } from '@tanstack/react-query';
import { get } from './api';

export const adminBadgeKeys = {
  list: ['admin', 'badges'] as const,
  suggestions: (status: SuggestionStatus) => ['admin', 'badge-suggestions', status] as const,
  suggestionsAll: ['admin', 'badge-suggestions'] as const,
  status: ['admin', 'badge-import-status'] as const,
};

export const useAdminBadgeList = () =>
  useQuery({
    queryKey: adminBadgeKeys.list,
    queryFn: () => get<AdminBadge[]>('/api/admin/badges'),
  });

/** Polls every 3 seconds while a check is running. */
export const useImportStatus = (enabled = true) =>
  useQuery({
    queryKey: adminBadgeKeys.status,
    enabled,
    queryFn: () => get<BadgeImportStatus>('/api/admin/badge-suggestions/status'),
    refetchInterval: (q) => (q.state.data?.running ? 3_000 : 30_000),
  });

export const useSuggestions = (status: SuggestionStatus, enabled = true) =>
  useQuery({
    queryKey: adminBadgeKeys.suggestions(status),
    enabled,
    queryFn: async () =>
      (
        await get<{ suggestions: BadgeSuggestion[] }>(
          `/api/admin/badge-suggestions?status=${status}`,
        )
      ).suggestions,
  });
