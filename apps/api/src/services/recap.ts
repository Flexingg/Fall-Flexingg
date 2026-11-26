/**
 * The weekly recap: last Monday to Sunday in numbers. The recap page always works the numbers out
 * from the stored daily data, so it agrees with Trends; the Monday notification only links to it.
 */
import {
  addDays,
  bestStepDay,
  buildRecapTotals,
  formatCompact,
  formatPercent,
  isoWeekStart,
  previousIsoWeek,
  todayIn,
  type WeeklyRecap,
} from '@gauntlet/shared';
import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import {
  challengeParticipants,
  challenges,
  dailyMetrics,
  feedEvents,
  users,
} from '../db/schema.js';
import { listForUser } from './challenges.js';
import { displayFor } from './display.js';
import { notify } from './notify.js';
import { recordBadge } from './records.js';

const RECAP_METRICS = ['steps', 'distance', 'active_minutes', 'workouts', 'lift_volume'];
/** Recaps go out on Monday morning, local time, once this hour has come. */
export const RECAP_HOUR = 7;

export async function buildRecap(
  ctx: AppContext,
  userId: string,
  week: string,
): Promise<WeeklyRecap> {
  const start = isoWeekStart(week);
  const end = addDays(start, 6);
  const rows = await ctx.db
    .select({ date: dailyMetrics.date, metric: dailyMetrics.metric, value: dailyMetrics.value })
    .from(dailyMetrics)
    .where(
      and(
        eq(dailyMetrics.userId, userId),
        inArray(dailyMetrics.metric, RECAP_METRICS),
        gte(dailyMetrics.date, addDays(start, -7)),
        lte(dailyMetrics.date, end),
      ),
    );
  const totals = buildRecapTotals(rows, start);
  const prefs = await displayFor(ctx, userId);

  const weekStartInstant = new Date(`${start}T00:00:00Z`);
  const weekEndInstant = new Date(`${addDays(end, 1)}T00:00:00Z`);
  const records = (
    await ctx.db
      .select({ payload: feedEvents.payload })
      .from(feedEvents)
      .where(
        and(
          eq(feedEvents.actorId, userId),
          eq(feedEvents.kind, 'personal_record'),
          gte(feedEvents.createdAt, weekStartInstant),
          lt(feedEvents.createdAt, weekEndInstant),
        ),
      )
  ).map((r) => {
    const p = r.payload as { label?: string };
    return [p.label ? `New ${p.label}` : 'New personal record', recordBadge(r.payload, prefs)]
      .filter(Boolean)
      .join(': ');
  });

  // Challenges that ended that week, and where they stand in the ones still running.
  const mine = await listForUser(ctx, userId);
  const finishedRows = await ctx.db
    .select({
      id: challenges.id,
      name: challenges.name,
      rank: challengeParticipants.finalRank,
    })
    .from(challengeParticipants)
    .innerJoin(challenges, eq(challenges.id, challengeParticipants.challengeId))
    .where(
      and(
        eq(challengeParticipants.userId, userId),
        eq(challengeParticipants.state, 'joined'),
        isNotNull(challengeParticipants.finalRank),
        isNull(challenges.solo),
        gte(challenges.endDate, start),
        lte(challenges.endDate, end),
      ),
    );
  const sizes = new Map(mine.map((c) => [c.id, c.participantCount]));
  const finished = finishedRows.map((r) => ({
    challengeId: r.id,
    name: r.name,
    rank: r.rank!,
    of: sizes.get(r.id) ?? r.rank!,
  }));
  const standings = mine
    .filter((c) => c.status === 'active' && c.myState === 'joined' && !c.solo && c.myRank != null)
    .map((c) => ({
      challengeId: c.id,
      name: c.name,
      rank: c.myRank!,
      of: c.participantCount,
    }));

  const hasData = totals.some((t) => t.value > 0);
  return {
    week,
    start,
    end,
    hasData,
    totals,
    bestDay: bestStepDay(rows, start),
    records,
    finished,
    standings,
  };
}

/** Local weekday (Monday = 1) and hour for an instant in a time zone. */
export function localClock(instant: Date, timeZone: string): { isMonday: boolean; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(instant);
  return {
    isMonday: parts.find((p) => p.type === 'weekday')?.value === 'Mon',
    hour: Number(parts.find((p) => p.type === 'hour')?.value ?? 0),
  };
}

/**
 * Send last week's recap to everyone it is time for: Monday after 7:00 in their own time zone, once
 * per week, only if they recorded anything. Returns how many went out.
 */
export async function sendWeeklyRecaps(ctx: AppContext): Promise<number> {
  const now = ctx.now();
  const people = await ctx.db
    .select({ id: users.id, timezone: users.timezone, last: users.lastRecapWeek })
    .from(users)
    .where(eq(users.isDemo, false));
  let sent = 0;
  for (const u of people) {
    const clock = localClock(now, u.timezone);
    if (!clock.isMonday || clock.hour < RECAP_HOUR) continue;
    const today = todayIn(u.timezone, now);
    const week = previousIsoWeek(today);
    if (u.last === week) continue;

    // Claim the week first, so overlapping cycles can't send it twice.
    const [claimed] = await ctx.db
      .update(users)
      .set({ lastRecapWeek: week })
      .where(and(eq(users.id, u.id), sql`${users.lastRecapWeek} is distinct from ${week}`))
      .returning({ id: users.id });
    if (!claimed) continue;

    const prefs = await displayFor(ctx, u.id);
    const recap = await buildRecap(ctx, u.id, week);
    if (!recap.hasData) continue;
    const t = (k: string) => recap.totals.find((x) => x.key === k)!;
    const steps = t('steps');
    const parts = [
      steps.value > 0
        ? `${formatCompact(steps.value, 1, prefs)} steps${steps.changePct != null ? ` (${formatPercent(steps.changePct, prefs, 0, true)})` : ''}`
        : null,
      t('workouts').value > 0
        ? `${t('workouts').value} workout${t('workouts').value === 1 ? '' : 's'}`
        : null,
      recap.records.length
        ? `${recap.records.length} new record${recap.records.length === 1 ? '' : 's'}`
        : null,
    ].filter(Boolean);
    await notify(ctx, u.id, {
      kind: 'weekly_recap',
      title: 'Your week in review',
      body: parts.length ? `Last week: ${parts.join(', ')}.` : 'See how last week went.',
      url: `/recap/${week}`,
      payload: { week },
    });
    sent++;
  }
  return sent;
}
