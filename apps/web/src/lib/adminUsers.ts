/** Admin → Accounts and Challenges data: the account list and detail, the audit trail, challenges. */
import type {
  AccountFilter,
  AdminAuditEntry,
  AdminChallengeStatus,
  AdminChallengesResponse,
  AdminUserDetail,
  AdminUsersResponse,
  BadgeBackfillStatus,
} from '@gauntlet/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { get } from './api';

export const adminUserKeys = {
  all: ['admin', 'users'] as const,
  list: (q: string, filter: AccountFilter, limit: number) =>
    ['admin', 'users', 'list', q, filter, limit] as const,
  detail: (id: string) => ['admin', 'users', 'detail', id] as const,
  audit: ['admin', 'audit'] as const,
  challenges: (status: AdminChallengeStatus, q: string) =>
    ['admin', 'challenges', status, q] as const,
  backfill: ['admin', 'badge-backfill'] as const,
};

export const useAdminUsers = (q: string, filter: AccountFilter, limit: number) =>
  useQuery({
    queryKey: adminUserKeys.list(q, filter, limit),
    queryFn: () =>
      get<AdminUsersResponse>(
        `/api/admin/users?${new URLSearchParams({ q, filter, limit: String(limit) })}`,
      ),
    placeholderData: keepPreviousData,
  });

export const useAdminUser = (id: string) =>
  useQuery({
    queryKey: adminUserKeys.detail(id),
    queryFn: () => get<AdminUserDetail>(`/api/admin/users/${id}`),
  });

export const useAdminAudit = () =>
  useQuery({
    queryKey: adminUserKeys.audit,
    queryFn: async () => (await get<{ entries: AdminAuditEntry[] }>('/api/admin/audit')).entries,
  });

export const useAdminChallenges = (status: AdminChallengeStatus, q: string) =>
  useQuery({
    queryKey: adminUserKeys.challenges(status, q),
    queryFn: () =>
      get<AdminChallengesResponse>(`/api/admin/challenges?${new URLSearchParams({ status, q })}`),
    placeholderData: keepPreviousData,
  });

/** Polls every 2 seconds while badges are being awarded. */
export const useBadgeBackfill = () =>
  useQuery({
    queryKey: adminUserKeys.backfill,
    queryFn: () => get<BadgeBackfillStatus>('/api/admin/badges/backfill'),
    refetchInterval: (q) => (q.state.data?.running ? 2_000 : 30_000),
  });

/** "3 days ago"-style text for how long it has been since someone used the app. */
export function lastActiveText(iso: string | null, createdAt: string): string {
  const then = new Date(iso ?? createdAt).getTime();
  const days = Math.floor((Date.now() - then) / 86_400_000);
  const base = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  return iso ? base : `never (joined ${base})`;
}
