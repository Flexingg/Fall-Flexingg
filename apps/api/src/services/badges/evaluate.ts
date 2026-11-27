/**
 * Rule evaluation: for one person and one badge rule, work out the number the rule's tiers are
 * compared against ("1,240,000 steps", "a 12 km run", "7 wins") plus where that came from, so the
 * engine can say which challenge or day earned it. One query (or two) per rule type, all in SQL over
 * the tables sync and challenges already fill; nothing here is executed from the rule itself except
 * through these fixed queries.
 *
 * Conventions:
 *  - A badge window limits which data counts (days, activities, challenges that ended in it).
 *    windowOpen() says whether the badge can still be earned at all.
 *  - Today's totals count (a badge can land the same day), for streaks and best periods too.
 *  - Dates are the person's own (daily_metrics dates already are; timestamps use their zone).
 *  - `countsManual: false` drops hand-typed activities. Daily totals can't tell, so they always count.
 *  - Group-challenge rules never count solo challenges.
 */
import {
  addDays,
  metricDef,
  stakeOutcome,
  todayIn,
  type BadgeRule,
  type MetricKey,
} from '@gauntlet/shared';
import { inArray, sql, type SQL } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { dailyMetrics, rankSnapshots } from '../../db/schema.js';

export interface EvalDef {
  rule: BadgeRule;
  window: { start: string; end: string } | null;
  countsManual: boolean;
}

export interface EvalUser {
  id: string;
  timezone: string;
}

export interface Evaluation {
  /** The number compared with the tier thresholds. */
  value: number;
  /** Where the given tier's threshold was crossed (a challenge, a day...). */
  contextFor: (threshold: number) => Record<string, unknown>;
}

/** A windowed badge can be earned from its first day until a day after its last (late syncs). */
export function windowOpen(window: EvalDef['window'], today: string): boolean {
  return !window || (today >= window.start && today <= addDays(window.end, 1));
}

const MEASURE_COLUMN = { distance_km: 'distance_km', minutes: 'minutes', kcal: 'kcal' } as const;

/** Rule types that read each kind of data, so a sync doesn't re-check what only a challenge changes. */
export const DATA_RULES = new Set<BadgeRule['type']>([
  'lifetime_total',
  'best_period',
  'streak',
  'count_days',
  'single_activity',
  'activity_count',
  'activity_total',
  'date_active',
]);

export async function evaluateRule(
  ctx: AppContext,
  user: EvalUser,
  def: EvalDef,
): Promise<Evaluation> {
  const e = new Evaluator(ctx, user, def);
  return e.run();
}

class Evaluator {
  private readonly today: string;
  constructor(
    private readonly ctx: AppContext,
    private readonly user: EvalUser,
    private readonly def: EvalDef,
  ) {
    this.today = todayIn(user.timezone, ctx.now());
  }

  private get w() {
    return this.def.window;
  }
  private plain(value: number, extra: Record<string, unknown> = {}): Evaluation {
    return { value, contextFor: () => ({ date: this.today, ...extra }) };
  }
  private async rows<T extends Record<string, unknown>>(q: SQL): Promise<T[]> {
    return [...(await this.ctx.db.execute<T>(q))] as unknown as T[];
  }

  /** `and col between window` on a date column. */
  private dateWin(col: string): SQL {
    return this.w
      ? sql`and ${sql.raw(col)} >= ${this.w.start}::date and ${sql.raw(col)} <= ${this.w.end}::date`
      : sql``;
  }
  /** Same for a timestamp column, read in the person's own zone. */
  private tsWin(col: string): SQL {
    const local = sql`(${sql.raw(col)} at time zone ${this.user.timezone})::date`;
    return this.w
      ? sql`and ${local} >= ${this.w.start}::date and ${local} <= ${this.w.end}::date`
      : sql``;
  }

  async run(): Promise<Evaluation> {
    const r = this.def.rule;
    switch (r.type) {
      case 'lifetime_total':
        return this.lifetimeTotal(r.metric);
      case 'best_period':
        return this.bestPeriod(r.metric, r.period);
      case 'streak':
        return this.streak(r.metric, r.min);
      case 'count_days':
        return this.countDays(r.metric, r.min, r.hours);
      case 'single_activity':
        return this.singleActivity(r);
      case 'activity_count':
        return this.activityCount(r);
      case 'activity_total':
        return this.activityTotal(r);
      case 'challenge_result':
        return this.challengeResult(r);
      case 'social':
        return this.social(r.event);
      case 'date_active':
        return this.dateActive(r.metric, r.min, r.month, r.day);
    }
  }

  // ---------- Daily metrics ----------

  private async lifetimeTotal(metric: string): Promise<Evaluation> {
    const [row] = await this.rows<{ v: number }>(sql`
      select coalesce(sum(value), 0)::float8 as v from daily_metrics
      where user_id = ${this.user.id} and metric = ${metric} ${this.dateWin('date')}`);
    return this.plain(row?.v ?? 0);
  }

  private async bestPeriod(metric: string, period: 'day' | 'week' | 'month'): Promise<Evaluation> {
    if (period === 'day') {
      const [row] = await this.rows<{ v: number; d: string }>(sql`
        select value::float8 as v, date::text as d from daily_metrics
        where user_id = ${this.user.id} and metric = ${metric} ${this.dateWin('date')}
        order by value desc, date limit 1`);
      return this.plain(row?.v ?? 0, row ? { date: row.d } : {});
    }
    const unit = period === 'week' ? 'week' : 'month';
    const [row] = await this.rows<{ v: number }>(sql`
      select coalesce(max(s), 0)::float8 as v from (
        select sum(value) as s from daily_metrics
        where user_id = ${this.user.id} and metric = ${metric} ${this.dateWin('date')}
        group by date_trunc(${unit}, date::timestamp)) t`);
    return this.plain(row?.v ?? 0);
  }

  private async streak(metric: string, min: number): Promise<Evaluation> {
    const rows = await this.rows<{ d: string }>(sql`
      select date::text as d from daily_metrics
      where user_id = ${this.user.id} and metric = ${metric} and value >= ${min} ${this.dateWin('date')}
      order by date`);
    // Longest run of consecutive days, remembering the day each length was first reached.
    let best = 0;
    let run = 0;
    let prev: string | null = null;
    const reached = new Map<number, string>();
    for (const { d } of rows) {
      run = prev && addDays(prev, 1) === d ? run + 1 : 1;
      if (run > best) {
        best = run;
        reached.set(run, d);
      }
      prev = d;
    }
    return {
      value: best,
      contextFor: (t) => ({ date: reached.get(Math.ceil(t)) ?? this.today }),
    };
  }

  private async countDays(
    metric: string,
    min: number,
    hours?: { from: number; to: number },
  ): Promise<Evaluation> {
    const manual = this.def.countsManual ? sql`` : sql`and not a.manual`;
    const during = hours
      ? sql`and exists (select 1 from activities a where a.user_id = d.user_id and a.date = d.date
          and ${this.hourSql('a.start_hour', hours)} ${manual})`
      : sql``;
    const [row] = await this.rows<{ v: number }>(sql`
      select count(*)::int as v from daily_metrics d
      where d.user_id = ${this.user.id} and d.metric = ${metric} and d.value >= ${min}
        ${this.dateWin('d.date')} ${during}`);
    return this.plain(row?.v ?? 0);
  }

  private async dateActive(
    metric: string,
    min: number,
    month: number,
    day: number,
  ): Promise<Evaluation> {
    const rows = await this.rows<{ d: string }>(sql`
      select date::text as d from daily_metrics
      where user_id = ${this.user.id} and metric = ${metric} and value >= ${min}
        and extract(month from date) = ${month} and extract(day from date) = ${day}
        ${this.dateWin('date')}
      order by date desc`);
    const years = new Set(rows.map((r) => r.d.slice(0, 4)));
    return this.plain(years.size, rows[0] ? { date: rows[0].d } : {});
  }

  // ---------- Activities ----------

  private hourSql(col: string, h: { from: number; to: number }): SQL {
    const c = sql.raw(col);
    return h.from <= h.to
      ? sql`(${c} is not null and ${c} >= ${h.from} and ${c} < ${h.to})`
      : sql`(${c} is not null and (${c} >= ${h.from} or ${c} < ${h.to}))`;
  }

  /** The WHERE conditions shared by every activity rule (after `where user_id = ...`). */
  private activityFilter(sport: string, hours?: { from: number; to: number }): SQL {
    return sql`${sport === 'any' ? sql`` : sql`and sport = ${sport}`}
      ${this.def.countsManual ? sql`` : sql`and not manual`}
      ${hours ? sql`and ${this.hourSql('start_hour', hours)}` : sql``}
      ${this.dateWin('date')}`;
  }

  private async singleActivity(
    r: Extract<BadgeRule, { type: 'single_activity' }>,
  ): Promise<Evaluation> {
    const col = sql.raw(MEASURE_COLUMN[r.measure]);
    const rows = await this.rows<{ id: string; d: string; v: number }>(sql`
      select id, date::text as d, ${col}::float8 as v from activities
      where user_id = ${this.user.id} and ${col} is not null ${this.activityFilter(r.sport, r.hours)}
      order by date, id`);
    const best = rows.reduce((m, x) => Math.max(m, x.v), 0);
    return {
      value: best,
      contextFor: (t) => {
        const hit = rows.find((x) => x.v >= t);
        return hit ? { date: hit.d, activityId: hit.id } : { date: this.today };
      },
    };
  }

  private async activityCount(
    r: Extract<BadgeRule, { type: 'activity_count' }>,
  ): Promise<Evaluation> {
    const size =
      r.measure && r.min ? sql`and ${sql.raw(MEASURE_COLUMN[r.measure])} >= ${r.min}` : sql``;
    const [row] = await this.rows<{ v: number }>(sql`
      select count(*)::int as v from activities
      where user_id = ${this.user.id} ${size} ${this.activityFilter(r.sport, r.hours)}`);
    return this.plain(row?.v ?? 0);
  }

  private async activityTotal(
    r: Extract<BadgeRule, { type: 'activity_total' }>,
  ): Promise<Evaluation> {
    const col = sql.raw(MEASURE_COLUMN[r.measure]);
    const [row] = await this.rows<{ v: number }>(sql`
      select coalesce(sum(${col}), 0)::float8 as v from activities
      where user_id = ${this.user.id} ${this.activityFilter(r.sport)}`);
    return this.plain(row?.v ?? 0);
  }

  // ---------- Challenges ----------

  private async challengeResult(
    r: Extract<BadgeRule, { type: 'challenge_result' }>,
  ): Promise<Evaluation> {
    const placeSql =
      r.place === 1
        ? sql`and cp.final_rank = 1`
        : r.place === 3
          ? sql`and cp.final_rank <= 3`
          : sql``;
    const all = await this.rows<ChallengeHit>(sql`
      select c.id, c.name, c.end_date::text as end_date, c.start_date::text as start_date,
             c.metric, c.custom_label, c.custom_unit, c.aggregate, c.lower_is_better,
             cp.final_rank as rank, cp.final_score::float8 as score,
             (select count(*)::int from challenge_participants f
               where f.challenge_id = c.id and f.state = 'joined' and f.final_score is not null) as field
      from challenge_participants cp join challenges c on c.id = cp.challenge_id
      where cp.user_id = ${this.user.id} and cp.state = 'joined' and cp.final_rank is not null
        and cp.final_score is not null and c.finalized_at is not null and c.solo is null
        ${r.teamOnly ? sql`and c.team_scoring is not null` : sql``}
        ${placeSql} ${this.dateWin('c.end_date')}
      order by c.end_date, c.created_at`);
    let hits = all.filter((h) => h.field >= Math.max(2, r.minParticipants ?? 2));
    if (r.drama) {
      const keep: ChallengeHit[] = [];
      for (const h of hits) if (await this.hasDrama(r.drama, h)) keep.push(h);
      hits = keep;
    }
    return {
      value: hits.length,
      contextFor: (t) => {
        const h = hits[Math.ceil(t) - 1];
        return h
          ? { challengeId: h.id, challengeName: h.name, date: h.end_date }
          : { date: this.today };
      },
    };
  }

  private async hasDrama(kind: string, h: ChallengeHit): Promise<boolean> {
    const me = this.user.id;
    if (kind === 'photo_finish') {
      if (h.rank !== 1 || !h.score) return false;
      const others = await this.rows<{ rank: number; score: number }>(sql`
        select final_rank as rank, final_score::float8 as score from challenge_participants
        where challenge_id = ${h.id} and state = 'joined' and user_id <> ${me} and final_score is not null`);
      if (others.some((o) => o.rank === 1)) return false;
      const second = others.filter((o) => o.rank === 2).map((o) => o.score);
      if (!second.length) return false;
      return Math.abs(h.score - second[0]!) / Math.abs(h.score) < 0.01;
    }
    if (kind === 'comeback' || kind === 'wire_to_wire') {
      if (h.rank !== 1) return false;
      const snaps = await this.ctx.db
        .select({
          date: rankSnapshots.date,
          userId: rankSnapshots.userId,
          rank: rankSnapshots.rank,
        })
        .from(rankSnapshots)
        .where(sql`${rankSnapshots.challengeId} = ${h.id}`);
      const dates = [...new Set(snaps.map((s) => s.date))].sort();
      if (kind === 'wire_to_wire') {
        if (dates.length < 3) return false;
        return dates.every((d) =>
          snaps.some((s) => s.date === d && s.userId === me && s.rank === 1),
        );
      }
      // Comeback: last place on the standings nearest the halfway point, then won.
      const span = Math.floor(
        (Date.parse(`${h.end_date}T00:00:00Z`) - Date.parse(`${h.start_date}T00:00:00Z`)) /
          86_400_000 /
          2,
      );
      const mid = addDays(h.start_date, span);
      const at = [...dates].reverse().find((d) => d <= mid);
      if (!at) return false;
      const that = snaps.filter((s) => s.date === at);
      const worst = Math.max(...that.map((s) => s.rank));
      const mine = that.find((s) => s.userId === me);
      return that.length >= 3 && !!mine && mine.rank === worst && worst > 1;
    }
    if (kind === 'giant_killer') {
      if (h.lower_is_better) return false;
      const field = await this.rows<{ user_id: string; rank: number }>(sql`
        select user_id, final_rank as rank from challenge_participants
        where challenge_id = ${h.id} and state = 'joined' and final_score is not null`);
      const beaten = field.filter((f) => f.user_id !== me && f.rank > h.rank).map((f) => f.user_id);
      if (!beaten.length) return false;
      const def = (() => {
        try {
          return metricDef(h.metric as MetricKey, {
            label: h.custom_label ?? h.metric,
            unit: h.custom_unit ?? undefined,
            aggregate: h.aggregate,
            lowerIsBetter: h.lower_is_better,
          });
        } catch {
          return null;
        }
      })();
      const metric = def?.source ?? h.metric;
      const from = addDays(h.start_date, -30);
      const before = await this.ctx.db
        .select({
          userId: dailyMetrics.userId,
          total: sql<number>`sum(${dailyMetrics.value})::float8`,
          avg: sql<number>`avg(${dailyMetrics.value})::float8`,
        })
        .from(dailyMetrics)
        .where(
          sql`${inArray(dailyMetrics.userId, [me, ...beaten])} and ${dailyMetrics.metric} = ${metric}
            and ${dailyMetrics.date} >= ${from}::date and ${dailyMetrics.date} < ${h.start_date}::date`,
        )
        .groupBy(dailyMetrics.userId);
      const typical = (u: string) => {
        const row = before.find((b) => b.userId === u);
        if (!row) return 0;
        return h.aggregate === 'sum' ? row.total / 30 : row.avg;
      };
      const mine = typical(me);
      return mine > 0 && beaten.some((u) => typical(u) >= mine * 3);
    }
    return false;
  }

  // ---------- Social ----------

  private async social(event: string): Promise<Evaluation> {
    const me = this.user.id;
    const count = async (q: SQL) => (await this.rows<{ v: number }>(q))[0]?.v ?? 0;
    switch (event) {
      case 'reactions_sent':
        // Cheering other people's items, once per item (toggling doesn't count twice).
        return this.plain(
          await count(sql`select count(distinct fr.event_id)::int as v from feed_reactions fr
            join feed_events fe on fe.id = fr.event_id
            where fr.user_id = ${me} and fe.actor_id <> ${me} ${this.tsWin('fr.created_at')}`),
        );
      case 'comments_sent':
        return this.plain(
          await count(sql`select count(*)::int as v from feed_comments fc
            join feed_events fe on fe.id = fc.event_id
            where fc.user_id = ${me} and fe.actor_id <> ${me} ${this.tsWin('fc.created_at')}`),
        );
      case 'challenges_created':
        // Group challenges you started (later rounds of a repeating one start themselves).
        return this.plain(
          await count(sql`select count(*)::int as v from challenges
            where created_by = ${me} and solo is null and coalesce(series_round, 1) = 1
            ${this.tsWin('created_at')}`),
        );
      case 'challenges_joined':
        return this.plain(
          await count(sql`select count(*)::int as v from challenge_participants cp
            join challenges c on c.id = cp.challenge_id
            where cp.user_id = ${me} and cp.state = 'joined' and c.solo is null
              and c.created_by <> ${me} ${this.tsWin('cp.created_at')}`),
        );
      case 'team_challenges_joined':
        return this.plain(
          await count(sql`select count(*)::int as v from challenge_participants cp
            join challenges c on c.id = cp.challenge_id
            where cp.user_id = ${me} and cp.state = 'joined' and c.solo is null
              and cp.team_id is not null ${this.tsWin('cp.created_at')}`),
        );
      case 'friends':
        return this.plain(
          await count(sql`select count(*)::int as v from friendships
            where (user_low = ${me} or user_high = ${me}) and status = 'accepted'
            ${this.tsWin('accepted_at')}`),
        );
      case 'invite_joins':
        return this.plain(
          await count(sql`select count(*)::int as v from challenge_participants cp
            join challenges c on c.id = cp.challenge_id
            where cp.invited_by = ${me} and cp.user_id <> ${me} and cp.state = 'joined'
              and c.solo is null ${this.tsWin('cp.created_at')}`),
        );
      case 'rematches_won':
        return this.plain(
          await count(sql`select count(*)::int as v from challenge_participants cp
            join challenges c on c.id = cp.challenge_id
            where cp.user_id = ${me} and cp.state = 'joined' and cp.final_rank = 1
              and cp.final_score is not null and c.rematch_of is not null and c.solo is null
              and c.finalized_at is not null ${this.dateWin('c.end_date')}`),
        );
      case 'stakes_paid':
        return this.plain(await this.stakesPaid());
      case 'personal_records': {
        const stored = await count(sql`select count(*)::int as v from personal_records
          where user_id = ${me} ${this.tsWin('updated_at')}`);
        const beaten = await count(sql`select count(*)::int as v from feed_events
          where actor_id = ${me} and kind = 'personal_record' ${this.tsWin('created_at')}`);
        return this.plain(stored + beaten);
      }
    }
    return this.plain(0);
  }

  /** Side bets you lost and settled up (marked paid), counted from the final standings. */
  private async stakesPaid(): Promise<number> {
    const me = this.user.id;
    const settled = await this.rows<{ id: string }>(sql`
      select c.id from challenge_participants cp join challenges c on c.id = cp.challenge_id
      where cp.user_id = ${me} and cp.state = 'joined' and c.stake is not null
        and c.stake_settled_at is not null and c.solo is null and c.finalized_at is not null
        ${this.tsWin('c.stake_settled_at')}`);
    let paid = 0;
    for (const { id } of settled) {
      const field = await this.rows<{ user_id: string; rank: number; score: number | null }>(sql`
        select user_id, final_rank as rank, final_score::float8 as score from challenge_participants
        where challenge_id = ${id} and state = 'joined' and final_rank is not null`);
      const { losers } = stakeOutcome(
        field.map((f) => ({ id: f.user_id, rank: f.rank, score: f.score })),
      );
      if (losers.includes(me)) paid++;
    }
    return paid;
  }
}

type ChallengeHit = {
  id: string;
  name: string;
  end_date: string;
  start_date: string;
  metric: string;
  custom_label: string | null;
  custom_unit: string | null;
  aggregate: 'sum' | 'avg' | 'last';
  lower_is_better: boolean;
  rank: number;
  score: number;
  field: number;
};
