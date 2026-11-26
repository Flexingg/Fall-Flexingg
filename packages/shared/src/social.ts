/**
 * Contract for the social features: reactions and comments on the activity feed, and nudges.
 * Limits live here so the server and the screens agree on them.
 */
import { z } from 'zod';
import type { PublicUser } from './api.js';
import { REACTIONS, type Reaction } from './notify.js';

export const COMMENT_MAX = 280;

export const reactionBodySchema = z.object({ emoji: z.enum(REACTIONS) });
export const commentBodySchema = z.object({
  body: z.string().trim().min(1, 'Write something first').max(COMMENT_MAX, 'That is too long'),
});
export const nudgeBodySchema = z.object({
  userId: z.string().uuid(),
  challengeId: z.string().uuid().optional(),
});

/** One emoji on a feed item: how many people used it and whether you did. */
export interface FeedReaction {
  emoji: Reaction;
  count: number;
  mine: boolean;
}

export interface FeedComment {
  id: string;
  eventId: string;
  user: PublicUser;
  body: string;
  createdAt: string;
  /** You wrote it, or it is on your own activity. */
  canDelete: boolean;
}

export const NUDGE_PAIR_HOURS = 12;
export const NUDGE_DAILY_MAX = 10;

export interface NudgeStatus {
  canNudge: boolean;
  /** When nudging this person works again (null when it already does, or never will). */
  retryAt: string | null;
}
