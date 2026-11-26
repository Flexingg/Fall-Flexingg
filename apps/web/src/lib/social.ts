/** Queries and actions for reactions, comments and nudges (server-only features). */
import type { FeedComment, FeedEvent, NudgeStatus } from '@gauntlet/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post } from './api';
import { keys } from './queries';
import { session } from './session';

export const socialKeys = {
  item: (id: string) => ['feed', 'item', id] as const,
  comments: (id: string) => ['feed', 'comments', id] as const,
  nudge: (userId: string) => ['nudge', userId] as const,
};

export const useFeedItem = (id: string) =>
  useQuery({
    queryKey: socialKeys.item(id),
    queryFn: () => get<FeedEvent>(`/api/feed/${encodeURIComponent(id)}`),
    enabled: !!id && !session.direct,
    retry: false,
  });

export const useComments = (id: string) =>
  useQuery({
    queryKey: socialKeys.comments(id),
    queryFn: () => get<FeedComment[]>(`/api/feed/${encodeURIComponent(id)}/comments`),
    enabled: !!id && !session.direct,
  });

export const useNudgeStatus = (userId: string, enabled = true) =>
  useQuery({
    queryKey: socialKeys.nudge(userId),
    queryFn: () => get<NudgeStatus>(`/api/nudges/status/${encodeURIComponent(userId)}`),
    enabled: enabled && !!userId && !session.direct,
    staleTime: 15_000,
  });

/** Add or remove one of your reactions, then refresh everything that shows it. */
export function useToggleReaction() {
  const qc = useQueryClient();
  return async (eventId: string, emoji: string, mine: boolean) => {
    const path = `/api/feed/${encodeURIComponent(eventId)}/reactions`;
    if (mine) await del(`${path}/${encodeURIComponent(emoji)}`);
    else await post(path, { emoji });
    await Promise.all([
      qc.invalidateQueries({ queryKey: keys.feed }),
      qc.invalidateQueries({ queryKey: socialKeys.item(eventId) }),
    ]);
  };
}
