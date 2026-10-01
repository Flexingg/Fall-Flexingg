import { formatCompact, metricDef, type FeedEvent, type MetricKey } from '@gauntlet/shared';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { challengeParticipants, challenges, feedEvents } from '../db/schema.js';
import { friendIds } from './friends.js';
import { getUsers, shortName, toPublicUser } from './users.js';

export async function feedFor(ctx: AppContext, userId: string, limit = 30): Promise<FeedEvent[]> {
  const people = [userId, ...(await friendIds(ctx, userId))];
  const myChallenges = (
    await ctx.db
      .select({ id: challengeParticipants.challengeId })
      .from(challengeParticipants)
      .where(and(eq(challengeParticipants.userId, userId), eq(challengeParticipants.state, 'joined')))
  ).map((r) => r.id);

  const visible = myChallenges.length
    ? or(inArray(feedEvents.challengeId, myChallenges), and(isNull(feedEvents.challengeId), inArray(feedEvents.actorId, people)))
    : and(isNull(feedEvents.challengeId), inArray(feedEvents.actorId, people));

  const rows = await ctx.db
    .select({ e: feedEvents, chName: challenges.name, chMetric: challenges.metric, chLabel: challenges.customLabel, chUnit: challenges.customUnit })
    .from(feedEvents)
    .leftJoin(challenges, eq(challenges.id, feedEvents.challengeId))
    .where(visible)
    .orderBy(desc(feedEvents.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));

  const usersById = await getUsers(ctx, rows.map((r) => r.e.actorId));
  return rows.flatMap(({ e, chName, chMetric, chLabel, chUnit }) => {
    const actor = usersById.get(e.actorId);
    if (!actor) return [];
    const name = shortName(actor.displayName).split(' ')[0]!;
    const challenge = e.challengeId && chName ? { id: e.challengeId, name: chName } : null;
    const p = e.payload as Record<string, unknown>;
    let text = '';
    let badge: string | null = null;
    switch (e.kind) {
      case 'progress': {
        const metric = (p.metric as MetricKey | undefined) ?? (chMetric as MetricKey);
        const def = metricDef(metric, { label: chLabel ?? metric, unit: chUnit ?? undefined, aggregate: 'sum', lowerIsBetter: false });
        const delta = Number(p.delta ?? 0);
        const amount = def.decimals ? delta.toFixed(def.decimals) : Math.round(delta).toLocaleString('en-US');
        badge = `+${metric === 'steps' ? formatCompact(delta) : amount}`;
        text =
          metric === 'distance' ? `${name} covered ${amount} km`
          : metric === 'steps' ? `${name} hit ${formatCompact(delta)} steps`
          : metric === 'workouts' ? `${name} logged ${delta === 1 ? 'a workout' : `${amount} workouts`}`
          : metric === 'active_minutes' ? `${name} logged ${amount} active min`
          : metric === 'active_calories' ? `${name} burned ${amount} kcal`
          : `${name} logged ${amount}${def.unit ? ` ${def.unit}` : ''} ${def.label.toLowerCase()}`;
        break;
      }
      case 'took_lead':
        text = `${name} took the lead${challenge ? ` in ${challenge.name}` : ''}`;
        break;
      case 'challenge_won':
        text = `${name} won ${challenge?.name ?? 'a challenge'}`;
        badge = '1st';
        break;
      case 'joined':
        text = `${name} joined ${challenge?.name ?? 'a challenge'}`;
        break;
      case 'challenge_created':
        text = `${name} started ${challenge?.name ?? 'a challenge'}`;
        break;
      default:
        text = `${name} was active`;
    }
    return [
      {
        id: e.id,
        kind: e.kind as FeedEvent['kind'],
        actor: toPublicUser(actor),
        challenge,
        text,
        badge,
        // Which app the data came from is only shown if the person allows it.
        source: actor.shareWorkoutDetails && typeof p.source === 'string' ? p.source : null,
        createdAt: e.createdAt.toISOString(),
      },
    ];
  });
}
