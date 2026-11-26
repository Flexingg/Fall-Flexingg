/**
 * Month and year in review: one person's period in numbers, worked out from the stored daily data
 * (so it agrees with Trends and the weekly recap) plus their records and finished challenges.
 * Only ever built for yourself. A new month also sends one notification per person.
 */
import {
  RECAP_METRICS,
  bestMonthOf,
  bestStepDayIn,
  compactNumber,
  longestStepStreak,
  monthOf,
  parsePeriod,
  periodTotals,
  previousMonth,
  todayIn,
  weekdayPattern,
  STREAK_TARGET,
  type Review,
  type ReviewList,
  type ReviewPeriod,
  type ReviewRival,
} from '@gauntlet/shared';
import { and, between, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import {
  challengeParticipants,
  challenges,
  dailyMetrics,
  personalRecords,
  users,
} from '../db/schema.js';
import { notify } from './notify.js';
import { describeRecord } from './records.js';
import { localClock, RECAP_HOUR } from './recap.js';
import { getUser, getUsers } from './users.js';

const METRIC_KEYS: string[] = RECAP_METRICS.map((m) => m.key);
/** Month reviews go out during the first week of a month, so a day of downtime doesn't skip one. */
const SEND_WINDOW_DAYS = 7;

export async function buildReview(
  ctx: AppContext,
  userId: string,
  period: ReviewPeriod,
  today: string,
): Promise<Review> {
  const rows = await ctx.db
    .select({ date: dailyMetrics.date, metric: dailyMetrics.metric, value: dailyMetrics.value })
    .from(dailyMetrics)
    .where(
      and(
        eq(dailyMetrics.userId, userId),
        inArray(dailyMetrics.metric, METRIC_KEYS),
        between(dailyMetrics.date, period.prev.start, period.end),
      ),
    );
  const totals = periodTotals(rows, period);
  const activeDays = new Set(
    rows.filter((r) => r.date >= period.start && r.value > 0).map((r) => r.date),
  ).size;

  const recordRows = await ctx.db
    .select()
    .from(personalRecords)
    .where(
      and(
        eq(personalRecords.userId, userId),
        between(personalRecords.date, period.start, period.end),
      ),
    );
  const records = recordRows
    .flatMap((r) => {
      const d = describeRecord(r.key, r.value);
      return d ? [{ ...d, date: r.date, order: r.key.startsWith('lift') ? 0 : 1 }] : [];
    })
    .sort((a, b) => a.order - b.order || a.date.localeCompare(b.date))
    .map(({ label, badge, date }) => ({ label, badge, date }));

  const { challenges: played, rival } = await challengeSummary(ctx, userId, period);

  return {
    period: period.id,
    kind: period.kind,
    label: period.label,
    prevLabel: period.prevLabel,
    start: period.start,
    end: period.end,
    partial: period.end >= today,
    hasData: totals.some((t) => t.value > 0),
    activeDays,
    totals,
    bestDay: bestStepDayIn(rows, period.start, period.end),
    longestStreak: (() => {
      const s = longestStepStreak(rows, period.start, period.end);
      return s && s.days >= 2 ? s : null;
    })(),
    streakTarget: STREAK_TARGET,
    weekday: weekdayPattern(rows, period.start, period.end),
    bestMonth: period.kind === 'year' ? bestMonthOf(rows, period) : null,
    records,
    challenges: played,
    rival,
  };
}

/** Group challenges that finished in the period: how many you played, won, podiumed, and versus whom. */
async function challengeSummary(
  ctx: AppContext,
  userId: string,
  period: ReviewPeriod,
): Promise<{ challenges: Review['challenges']; rival: ReviewRival | null }> {
  const mine = await ctx.db
    .select({
      id: challenges.id,
      rank: challengeParticipants.finalRank,
      field: sql<number>`(select count(*)::int from challenge_participants f
        where f.challenge_id = ${challenges.id} and f.state = 'joined' and f.final_score is not null)`,
    })
    .from(challengeParticipants)
    .innerJoin(challenges, eq(challenges.id, challengeParticipants.challengeId))
    .where(
      and(
        eq(challengeParticipants.userId, userId),
        eq(challengeParticipants.state, 'joined'),
        isNotNull(challengeParticipants.finalScore),
        isNotNull(challengeParticipants.finalRank),
        isNull(challenges.solo),
        isNotNull(challenges.finalizedAt),
        between(challenges.endDate, period.start, period.end),
      ),
    );
  // Like the trophy board: a challenge only counts when at least two people had a score.
  const real = mine.filter((c) => c.field >= 2);
  const summary = {
    played: real.length,
    won: real.filter((c) => c.rank === 1).length,
    podiums: real.filter((c) => c.rank != null && c.rank <= 3).length,
  };
  if (!real.length) return { challenges: summary, rival: null };

  const myRank = new Map(real.map((c) => [c.id, c.rank!]));
  const others = await ctx.db
    .select({
      challengeId: challengeParticipants.challengeId,
      userId: challengeParticipants.userId,
      rank: challengeParticipants.finalRank,
    })
    .from(challengeParticipants)
    .where(
      and(
        inArray(challengeParticipants.challengeId, [...myRank.keys()]),
        ne(challengeParticipants.userId, userId),
        eq(challengeParticipants.state, 'joined'),
        isNotNull(challengeParticipants.finalScore),
        isNotNull(challengeParticipants.finalRank),
      ),
    );
  const tally = new Map<string, { shared: number; wins: number; losses: number }>();
  for (const o of others) {
    const t = tally.get(o.userId) ?? { shared: 0, wins: 0, losses: 0 };
    t.shared++;
    const mineRank = myRank.get(o.challengeId)!;
    if (mineRank < o.rank!) t.wins++;
    else if (mineRank > o.rank!) t.losses++;
    tally.set(o.userId, t);
  }
  const best = [...tally].sort(
    (a, b) => b[1].shared - a[1].shared || b[1].wins - a[1].wins || a[0].localeCompare(b[0]),
  )[0];
  if (!best) return { challenges: summary, rival: null };
  const name = (await getUsers(ctx, [best[0]])).get(best[0])?.displayName ?? 'A friend';
  return { challenges: summary, rival: { userId: best[0], displayName: name, ...best[1] } };
}

/** Months (and years) that have anything to review, newest first. */
export async function listReviews(ctx: AppContext, userId: string): Promise<ReviewList> {
  const rows = await ctx.db
    .selectDistinct({ month: sql<string>`substr(${dailyMetrics.date}::text, 1, 7)` })
    .from(dailyMetrics)
    .where(
      and(
        eq(dailyMetrics.userId, userId),
        inArray(dailyMetrics.metric, METRIC_KEYS),
        sql`${dailyMetrics.value} > 0`,
      ),
    );
  const months = rows
    .map((r) => r.month)
    .sort()
    .reverse();
  const years = [...new Set(months.map((m) => m.slice(0, 4)))];
  return { months, years };
}

export async function reviewFor(
  ctx: AppContext,
  userId: string,
  id: string,
): Promise<Review | null> {
  const period = parsePeriod(id);
  if (!period) return null;
  const user = await getUser(ctx, userId);
  return buildReview(ctx, userId, period, todayIn(user.timezone, ctx.now()));
}

/**
 * Early in a new month (after 7:00 local, in the first week), tell each person once that last
 * month's review is ready. In January the one message is about the whole year instead, which links
 * to the year (December is one tap away on Today and Me), so nobody gets two in a row. Tracked in
 * `lastReviewMonth`; the month is claimed before sending, and skipped when nothing was recorded.
 * Returns how many went out.
 */
export async function sendMonthReviews(ctx: AppContext): Promise<number> {
  const now = ctx.now();
  const people = await ctx.db
    .select({ id: users.id, timezone: users.timezone, last: users.lastReviewMonth })
    .from(users)
    .where(eq(users.isDemo, false));
  let sent = 0;
  for (const u of people) {
    const today = todayIn(u.timezone, now);
    if (Number(today.slice(8)) > SEND_WINDOW_DAYS) continue;
    if (localClock(now, u.timezone).hour < RECAP_HOUR && today.endsWith('-01')) continue;
    const month = previousMonth(monthOf(today));
    if (u.last && u.last >= month) continue;

    const [claimed] = await ctx.db
      .update(users)
      .set({ lastReviewMonth: month })
      .where(
        and(
          eq(users.id, u.id),
          sql`(${users.lastReviewMonth} is null or ${users.lastReviewMonth} < ${month})`,
        ),
      )
      .returning({ id: users.id });
    if (!claimed) continue;

    const yearly = month.endsWith('-12');
    const period = parsePeriod(yearly ? month.slice(0, 4) : month)!;
    const review = await buildReview(ctx, u.id, period, today);
    if (!review.hasData) continue;
    const steps = review.totals.find((t) => t.key === 'steps')!;
    const workouts = review.totals.find((t) => t.key === 'workouts')!;
    const parts = [
      steps.value > 0
        ? `${compactNumber(steps.value)} steps${steps.changePct != null ? ` (${steps.changePct >= 0 ? '+' : ''}${steps.changePct}% on ${period.prevLabel})` : ''}`
        : null,
      workouts.value > 0 ? `${workouts.value} workout${workouts.value === 1 ? '' : 's'}` : null,
      review.records.length
        ? `${review.records.length} new record${review.records.length === 1 ? '' : 's'}`
        : null,
    ].filter(Boolean);
    const row = await notify(ctx, u.id, {
      kind: 'month_review',
      title: `Your ${period.label} in review`,
      body: parts.length ? `${parts.join(', ')}. Tap to see the story.` : 'Tap to see the story.',
      url: `/review/${period.id}`,
      payload: { period: period.id },
    });
    if (row) sent++;
  }
  return sent;
}
