/**
 * "What counted": the workouts, lift sessions and fasts behind a challenge score, read from the
 * participant's own SparkyFitness when someone looks (nothing is stored in Gauntlet), plus the
 * day total Gauntlet already holds for metrics that have no single item.
 */
import {
  eventKindsFor,
  formatMetricValue,
  type DisplayPrefs,
  liftExercise,
  type ChallengeEvent,
  type EventGroup,
} from '@gauntlet/shared';
import { fetchEvents } from '@gauntlet/sparky';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { dailyMetrics } from '../db/schema.js';
import { displayFor } from './display.js';
import { challengeMetricDef, type ChallengeRow } from './challenges.js';
import { sparkyToken, toPublicUser, type UserRow } from './users.js';

const CACHE_MS = 120_000;
const CACHE_MAX = 2000;
const cache = new Map<string, { at: number; events: { date: string; event: ChallengeEvent }[] }>();

/** Test hook: forget what was fetched. */
export function clearEventsCache() {
  cache.clear();
}

async function fromSparky(
  ctx: AppContext,
  user: UserRow,
  date: string,
  kinds: ('workout' | 'lift' | 'fast')[],
  display: DisplayPrefs,
) {
  // The wording depends on the reader's units, so the cache is per units and number format.
  const key = `${user.id}|${date}|${kinds.join(',')}|${display.units}|${display.locale}`;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_MS) return hit.events;
  const events = await fetchEvents(ctx.sparky, sparkyToken(ctx, user), date, date, {
    kinds,
    timezone: user.timezone,
    display,
  });
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: now, events });
  return events;
}

export async function eventGroupFor(
  ctx: AppContext,
  ch: ChallengeRow,
  user: UserRow,
  date: string,
  viewerId: string,
): Promise<EventGroup> {
  const isMe = user.id === viewerId;
  const display = await displayFor(ctx, viewerId);
  const base = { user: toPublicUser(user), isMe };
  // People can keep their workouts private; their totals still count.
  if (user.isDemo || (!isMe && !user.shareEvents)) return { ...base, status: 'hidden', events: [] };

  const def = challengeMetricDef(ch);
  const kinds = eventKindsFor(ch.metric);
  const events: ChallengeEvent[] = [];

  const live = kinds.filter((k): k is 'workout' | 'lift' | 'fast' => k !== 'day');
  if (live.length) {
    if (user.keyStatus !== 'active' || !user.sparkyKeyEnc)
      return { ...base, status: 'unavailable', events: [] };
    try {
      const lift = liftExercise(ch.metric);
      for (const { event } of await fromSparky(ctx, user, date, live, display)) {
        // Per-exercise challenges only list that exercise.
        if (lift && event.kind === 'lift' && event.title.toLowerCase() !== lift.exercise) continue;
        events.push(event);
      }
    } catch (err) {
      ctx.log.warn({ err: String(err), userId: user.id }, 'events: SparkyFitness unavailable');
      return { ...base, status: 'unavailable', events: [] };
    }
  }

  if (kinds.includes('day')) {
    const [row] = await ctx.db
      .select({ value: dailyMetrics.value, source: dailyMetrics.source })
      .from(dailyMetrics)
      .where(
        and(
          eq(dailyMetrics.userId, user.id),
          eq(dailyMetrics.date, date),
          eq(dailyMetrics.metric, def.source ?? ch.metric),
        ),
      );
    // A day total built from the workouts above would only repeat them.
    if (row && !(row.source === 'workouts' && events.length > 0))
      events.push({
        id: `day:${date}`,
        kind: 'day',
        title: events.length ? 'Day total' : def.label,
        detail: formatMetricValue(row.value, def, true, display),
        // Source names follow the same "show my data sources" choice as the feed.
        source: isMe || user.shareWorkoutDetails ? row.source : null,
      });
  }
  return { ...base, status: 'ok', events };
}
