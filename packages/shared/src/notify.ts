/**
 * Shared contract for notifications, reactions and recurring challenges: the kinds, their defaults
 * and the small fixed sets the server validates against.
 */
import { z } from 'zod';

/** Everything Gauntlet can notify someone about. */
export const NOTIFICATION_KINDS = {
  lead_change: { label: 'Lead changes in your challenges', default: true },
  challenge_invite: { label: 'Challenge invites', default: true },
  challenge_finished: { label: 'Challenge results', default: true },
  friend_request: { label: 'Friend requests', default: true },
  nudge: { label: 'Nudges from friends', default: true },
  reaction: { label: 'Reactions to your activity', default: true },
  comment: { label: 'Comments on your activity', default: true },
  personal_record: { label: 'New personal records', default: true },
  weekly_recap: { label: 'Weekly recap (Mondays)', default: true },
  new_round: { label: 'A recurring challenge starts a new round', default: true },
  month_review: { label: 'Your month in review (and year in review)', default: true },
  badge: { label: 'Badges you earn', default: true },
  /** Notices from the server admin about your account. Always delivered; not in the settings list. */
  account: { label: 'Your account', default: true, alwaysOn: true },
} as const;

/** Kinds people cannot switch off. */
export const alwaysOnKinds = (
  Object.keys(NOTIFICATION_KINDS) as (keyof typeof NOTIFICATION_KINDS)[]
).filter((k) => 'alwaysOn' in NOTIFICATION_KINDS[k]);

export type NotificationKind = keyof typeof NOTIFICATION_KINDS;
export const notificationKinds = Object.keys(NOTIFICATION_KINDS) as NotificationKind[];
export const isNotificationKind = (k: string): k is NotificationKind => k in NOTIFICATION_KINDS;

/** Per kind: on or off. A kind not listed uses its default. */
export type NotificationPrefs = Partial<Record<NotificationKind, boolean>>;

export function wantsNotification(prefs: NotificationPrefs, kind: NotificationKind): boolean {
  if ((alwaysOnKinds as string[]).includes(kind)) return true;
  return prefs[kind] ?? NOTIFICATION_KINDS[kind].default;
}

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  url: string | null;
  createdAt: string;
  read: boolean;
}

/** The reactions people can leave on a feed item. */
export const REACTIONS = ['🔥', '💪', '👏', '😂', '😮'] as const;
export type Reaction = (typeof REACTIONS)[number];

/** A recurring challenge starts its next round when one ends. */
export const recurrenceSchema = z.object({
  every: z.enum(['week', 'month']),
  /** Invite everyone who joined the last round to the next one (they still accept). */
  carryOver: z.boolean().default(true),
  /** Stop after this many rounds (null = until the creator stops it). */
  maxRounds: z.number().int().min(2).max(52).nullable().default(null),
});
export type Recurrence = z.infer<typeof recurrenceSchema>;
