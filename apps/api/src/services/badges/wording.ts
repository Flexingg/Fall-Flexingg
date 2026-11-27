/**
 * Plain-English wording for badges, in the reader's own units and date style: how a tier was earned
 * ("A 22-day streak, Mar 2 – Mar 23, 2026") and where someone stands on a badge right now ("Current
 * streak: 3 days, since Nov 25" and "27 more days in a row reaches Gold."). Pure functions of a rule
 * plus facts the evaluator worked out, so views.ts and the timeline say the same thing.
 */
import {
  DRAMA_LABEL,
  SOCIAL_LABEL,
  SPORT_LABEL,
  SPORT_ONE,
  addDays,
  badgeMetricLabel,
  formatDate,
  formatFlexible,
  formatInt,
  formatQuantityFlexible,
  hoursText,
  isDateString,
  metricDef,
  ruleTiers,
  tierName,
  type BadgeRule,
  type BadgeStanding,
  type BadgeStat,
  type DisplayPrefs,
  type MetricKey,
} from '@gauntlet/shared';
import type { EvalFacts } from './evaluate.js';

export type Prefs = Pick<DisplayPrefs, 'units' | 'locale'>;

/** A threshold or progress value in the reader's units; only km/kg/L carry their unit into "{n}". */
export function formatValue(rule: BadgeRule, n: number, prefs: Prefs): string {
  let unit = '';
  if (rule.type === 'lifetime_total' || rule.type === 'best_period') {
    try {
      unit = metricDef(rule.metric as MetricKey).unit;
    } catch {
      unit = '';
    }
  } else if (
    (rule.type === 'single_activity' || rule.type === 'activity_total') &&
    rule.measure === 'distance_km'
  ) {
    unit = 'km';
  }
  if (unit === 'km' || unit === 'kg' || unit === 'L')
    return formatQuantityFlexible(n, unit, 1, prefs);
  return Number.isInteger(n) ? formatInt(n, prefs) : formatFlexible(n, prefs, 1);
}

// ---------- Small helpers ----------

const num = (n: number, prefs: Prefs) =>
  Number.isInteger(n) ? formatInt(n, prefs) : formatFlexible(n, prefs, 1);
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);
const count = (n: number, one: string, prefs: Prefs, many = `${one}s`) =>
  `${num(n, prefs)} ${plural(n, one, many)}`;
const cap = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
const lowerFirst = (s: string) => `${s.charAt(0).toLowerCase()}${s.slice(1)}`;

/** 1st, 2nd, 3rd, 11th... (English only, like the rest of the wording). */
export function ordinal(n: number): string {
  const r = n % 100;
  if (r >= 11 && r <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

export const validDay = (v: unknown): string | null =>
  typeof v === 'string' && isDateString(v) ? v : null;

/** "Mar 3", or "Mar 3, 2025" when it isn't this year. */
function dayText(date: string, prefs: Prefs, thisYear: string, forceYear = false): string {
  const withYear = forceYear || date.slice(0, 4) !== thisYear;
  return formatDate(date, prefs, {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

/** "Mar 2 – Mar 23, 2026": the year always closes the range, and opens it too when it differs. */
function rangeText(start: string, end: string, prefs: Prefs): string {
  if (start === end) return dayText(end, prefs, '', true);
  return `${dayText(start, prefs, end.slice(0, 4))} – ${dayText(end, prefs, '', true)}`;
}

/** The metric's amount worded for reading: "62 mi", "10,000 steps", "7 hours of sleep". */
function metricAmount(metric: string, n: number, prefs: Prefs): string {
  if (/^lift_/.test(metric)) return formatQuantityFlexible(n, 'kg', 1, prefs);
  let unit = '';
  try {
    unit = metricDef(metric as MetricKey).unit;
  } catch {
    unit = '';
  }
  if (unit === 'km' || unit === 'kg' || unit === 'L')
    return formatQuantityFlexible(n, unit, 1, prefs);
  if (unit === '%') return `${num(n, prefs)}%`;
  if (unit === 'pts') return `${num(n, prefs)} points`;
  return `${num(n, prefs)} ${badgeMetricLabel(metric)}`;
}

/** "10,000+ steps", "5+ km". */
function metricAtLeast(metric: string, n: number, prefs: Prefs): string {
  const a = metricAmount(metric, n, prefs);
  const m = /^([\d.,\s]+)(.*)$/.exec(a);
  return m ? `${m[1]!.trim()}+ ${m[2]!.trim()}`.trim() : `${a}+`;
}

type Measure = 'distance_km' | 'minutes' | 'kcal';
function measureAmount(measure: Measure, n: number, prefs: Prefs): string {
  if (measure === 'distance_km') return formatQuantityFlexible(n, 'km', 1, prefs);
  return `${num(n, prefs)} ${measure === 'minutes' ? 'min' : 'kcal'}`;
}

/** What a rule counts in, e.g. "steps": the amount worded for the rule's own measure. */
function ruleAmount(rule: BadgeRule, n: number, prefs: Prefs): string {
  if (rule.type === 'lifetime_total' || rule.type === 'best_period')
    return metricAmount(rule.metric, n, prefs);
  if (rule.type === 'single_activity' || rule.type === 'activity_total')
    return measureAmount(rule.measure, n, prefs);
  return num(n, prefs);
}

/** " between 5 am and 7 am" for a rule limited to certain hours. */
const hoursPart = (h?: { from: number; to: number }) => hoursText(h).replace(/^, /, ' ');

/** Round a shortfall up so "N more" never promises less than it takes. */
const up = (gap: number, target: number) =>
  Number.isInteger(target) ? Math.ceil(gap) : Math.ceil(gap * 10) / 10;

const reachWord = (nextTier: number, tierCount: number) => {
  const name = tierName(nextTier, tierCount);
  return name ? `reaches ${cap(name)}` : 'earns it';
};

// ---------- How a tier was earned ----------

export interface HowArgs {
  rule: BadgeRule;
  /** 1-based tier. */
  tier: number;
  context: Record<string, unknown>;
  prefs: Prefs;
  /** The viewer's current year ("2026"), so this year's dates stay short. */
  thisYear: string;
}

/** One line on how a tier was earned, or null when there is nothing more to say. */
export function howEarned({ rule, tier, context, prefs, thisYear }: HowArgs): string | null {
  const t = ruleTiers(rule)[tier - 1] ?? 1;
  const date = validDay(context.date);
  const day = (d: string) => dayText(d, prefs, thisYear);
  const on = date ? ` on ${day(date)}` : '';
  switch (rule.type) {
    case 'streak': {
      const len = Math.ceil(t);
      const from = validDay(context.from) ?? (date ? addDays(date, -(len - 1)) : null);
      return from && date
        ? `A ${len}-day streak, ${rangeText(from, date, prefs)}`
        : `A ${len}-day streak`;
    }
    case 'lifetime_total':
      return `Reached ${ruleAmount(rule, t, prefs)}${on}`;
    case 'count_days':
      return `${count(Math.ceil(t), 'day', prefs)} with ${metricAtLeast(rule.metric, rule.min, prefs)}${hoursPart(rule.hours)}${on}`;
    case 'best_period': {
      const from = validDay(context.from);
      const amount = ruleAmount(rule, t, prefs);
      if (rule.period === 'day') return `Reached ${amount} in one day${on}`;
      if (rule.period === 'week')
        return `Reached ${amount} in one week${from ? `, week of ${day(from)}` : on}`;
      return `Reached ${amount} in one month${
        from ? ` (${formatDate(from, prefs, { month: 'long', year: 'numeric' })})` : on
      }`;
    }
    case 'single_activity': {
      const value = typeof context.value === 'number' ? context.value : null;
      const sport =
        rule.sport === 'any' && typeof context.sport === 'string' && context.sport in SPORT_ONE
          ? (context.sport as keyof typeof SPORT_ONE)
          : rule.sport;
      return value != null
        ? `A ${measureAmount(rule.measure, value, prefs)} ${SPORT_ONE[sport]}${on}`
        : `A ${SPORT_ONE[sport]} of ${measureAmount(rule.measure, t, prefs)} or more${on}`;
    }
    case 'activity_count': {
      const big =
        rule.measure && rule.min ? ` of ${measureAmount(rule.measure, rule.min, prefs)}+` : '';
      return `Your ${ordinal(Math.ceil(t))} ${SPORT_ONE[rule.sport]}${big}${on}`;
    }
    case 'activity_total':
      return `Reached ${measureAmount(rule.measure, t, prefs)} across ${SPORT_LABEL[rule.sport]}${on}`;
    case 'challenge_result': {
      const name = typeof context.challengeName === 'string' ? context.challengeName : null;
      const what = name ?? 'a challenge';
      const tail = name ? '' : on;
      if (rule.drama) {
        const how = {
          comeback: 'a comeback win',
          photo_finish: 'a photo-finish win',
          wire_to_wire: 'a win from the first day to the last',
          giant_killer: 'a win over a much stronger field',
        }[rule.drama];
        return `${cap(how)} in ${what}${tail}`;
      }
      if (rule.place === 1) return `Won ${what}${tail}`;
      if (rule.place === 3) return `Finished on the podium in ${what}${tail}`;
      return `Finished ${what}${tail}`;
    }
    case 'social': {
      const n = ordinal(Math.ceil(t));
      const text: Record<string, string> = {
        reactions_sent: `Sent your ${n} reaction`,
        comments_sent: `Wrote your ${n} comment`,
        challenges_created: `Started your ${n} challenge`,
        challenges_joined: `Joined your ${n} challenge`,
        team_challenges_joined: `Joined your ${n} team challenge`,
        friends: `Made your ${n} friend`,
        invite_joins: `Your ${n} invite was accepted`,
        stakes_paid: `Paid your ${n} side bet`,
        rematches_won: `Won your ${n} rematch`,
        personal_records: `Set your ${n} personal record`,
      };
      return `${text[rule.event] ?? SOCIAL_LABEL[rule.event]}${on}`;
    }
    case 'date_active': {
      const dm = dayMonth(rule.month, rule.day, prefs);
      return `${cap(metricAtLeast(rule.metric, rule.min, prefs))} on ${dm}${
        t > 1 ? `, the ${ordinal(Math.ceil(t))} year` : ''
      }${date ? ` (${day(date)})` : ''}`;
    }
  }
}

const dayMonth = (month: number, day: number, prefs: Prefs) =>
  formatDate(`2000-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, prefs, {
    month: 'long',
    day: 'numeric',
  });

// ---------- Where someone stands ----------

export interface StandingArgs {
  rule: BadgeRule;
  window: { start: string; end: string } | null;
  /** Highest tier earned so far (0 = none). */
  reached: number;
  value: number;
  facts: EvalFacts | undefined;
  prefs: Prefs;
  /** The viewer's calendar day. */
  today: string;
  /** Whether to link the latest challenge (the viewer may see it). */
  canOpenChallenge: boolean;
}

const stat = (
  kind: BadgeStat['kind'],
  label: string,
  value: string,
  detail: string | null = null,
  to: string | null = null,
): BadgeStat => ({ kind, label, value, detail, to });

/** The "Your status" lines and one sentence on what to do next. */
export function buildStanding(a: StandingArgs): BadgeStanding {
  const { rule, prefs, today } = a;
  const tiers = ruleTiers(rule);
  const target = tiers[a.reached];
  const maxed = target == null;
  const reach = reachWord(a.reached + 1, tiers.length);
  const thisYear = today.slice(0, 4);
  const day = (d: string) => dayText(d, prefs, thisYear);
  const by = a.window ? ` if you get there by ${day(a.window.end)}` : '';
  const stats: BadgeStat[] = [];
  let next: string | null = null;
  // Sync can lag behind the data by a moment: the badge is as good as earned.
  const there = (v: number) => !maxed && v >= target;
  const landing = 'You are there; it lands the next time you sync.';

  switch (rule.type) {
    case 'streak': {
      const f = a.facts?.type === 'streak' ? a.facts : null;
      const current = f?.current ?? 0;
      stats.push(
        stat(
          'current',
          'Current streak',
          count(current, 'day', prefs),
          current > 0 && f?.currentStart
            ? `Since ${day(f.currentStart)}`
            : f?.lastDay
              ? `Last counted ${day(f.lastDay)}`
              : null,
        ),
      );
      if (f && f.best > 0 && f.bestStart && f.bestEnd)
        stats.push(
          stat(
            'best',
            'Best streak',
            count(f.best, 'day', prefs),
            rangeText(f.bestStart, f.bestEnd, prefs),
          ),
        );
      if (maxed) break;
      const gap = target - current;
      const goal = `${gap} more ${plural(gap, 'day')} in a row ${reach}${by}.`;
      if (current >= target) next = landing;
      else if (current === 0)
        next = `Start today: ${count(target, 'day', prefs)} in a row ${reach}${by}.`;
      else if (f && !f.todayCounted)
        next = `${streakAction(rule, prefs)} today to keep your ${current}-day streak going; ${goal}`;
      else next = goal;
      break;
    }
    case 'best_period': {
      const f = a.facts?.type === 'best_period' ? a.facts : null;
      const label = { day: 'day', week: 'week', month: 'month' }[rule.period];
      if (a.value > 0)
        stats.push(
          stat(
            'best',
            `Best ${label}`,
            ruleAmount(rule, a.value, prefs),
            f?.bestStart
              ? rule.period === 'day'
                ? day(f.bestStart)
                : rule.period === 'week'
                  ? `Week of ${day(f.bestStart)}`
                  : formatDate(f.bestStart, prefs, { month: 'long', year: 'numeric' })
              : null,
          ),
        );
      const so = f?.current ?? 0;
      if (f)
        stats.push(
          stat(
            'period',
            rule.period === 'day' ? 'Today so far' : `This ${label} so far`,
            ruleAmount(rule, so, prefs),
            rule.period === 'day' ? null : `Since ${day(f.currentStart)}`,
          ),
        );
      if (maxed) break;
      if (there(a.value)) next = landing;
      else if (so > 0 && so < target)
        next = `${ruleAmount(rule, up(target - so, target), prefs)} more ${
          rule.period === 'day' ? 'today' : `this ${label}`
        } ${reach}${by}.`;
      else next = `A ${label} of ${ruleAmount(rule, target, prefs)} ${reach}${by}.`;
      break;
    }
    case 'lifetime_total':
    case 'activity_total':
      stats.push(stat('total', 'Total so far', ruleAmount(rule, a.value, prefs)));
      if (maxed) break;
      next = there(a.value)
        ? landing
        : `${ruleAmount(rule, up(target - a.value, target), prefs)} more ${reach}${by}.`;
      break;
    case 'count_days': {
      stats.push(
        stat(
          'total',
          'Days so far',
          count(a.value, 'day', prefs),
          `With ${metricAtLeast(rule.metric, rule.min, prefs)}${hoursPart(rule.hours)}`,
        ),
      );
      if (maxed) break;
      const gap = Math.ceil(target - a.value);
      next = there(a.value)
        ? landing
        : `${gap} more ${plural(gap, 'day')} with ${metricAtLeast(rule.metric, rule.min, prefs)}${hoursPart(rule.hours)} ${reach}${by}.`;
      break;
    }
    case 'activity_count': {
      const big =
        rule.measure && rule.min ? ` of ${measureAmount(rule.measure, rule.min, prefs)}+` : '';
      stats.push(
        stat('total', `${cap(SPORT_LABEL[rule.sport])}${big} so far`, num(a.value, prefs)),
      );
      if (maxed) break;
      const gap = Math.ceil(target - a.value);
      next = there(a.value)
        ? landing
        : `${gap} more ${gap === 1 ? SPORT_ONE[rule.sport] : SPORT_LABEL[rule.sport]}${big}${hoursPart(rule.hours)} ${reach}${by}.`;
      break;
    }
    case 'single_activity': {
      const f = a.facts?.type === 'single_activity' ? a.facts : null;
      if (f?.best)
        stats.push(
          stat(
            'best',
            `Best ${SPORT_ONE[rule.sport]}`,
            measureAmount(rule.measure, f.best.value, prefs),
            `${day(f.best.date)} · ${f.best.name}`,
          ),
        );
      if (maxed) break;
      next = there(a.value)
        ? landing
        : `A ${SPORT_ONE[rule.sport]} of ${measureAmount(rule.measure, target, prefs)} or more${hoursPart(rule.hours)} ${reach}${by}.`;
      break;
    }
    case 'challenge_result': {
      const f = a.facts?.type === 'challenge_result' ? a.facts : null;
      const team = rule.teamOnly ? 'team ' : '';
      const [label, latestLabel, one, many] = rule.drama
        ? [
            DRAMA_LABEL[rule.drama],
            'Latest',
            lowerFirst(DRAMA_LABEL[rule.drama]),
            lowerFirst(DRAMA_LABEL[rule.drama]),
          ]
        : rule.place === 1
          ? ['Challenges won', 'Latest win', `${team}win`, `${team}wins`]
          : rule.place === 3
            ? ['Podium finishes', 'Latest podium', `${team}podium finish`, `${team}podium finishes`]
            : [
                'Challenges finished',
                'Latest finish',
                `${team}challenge finished`,
                `${team}challenges finished`,
              ];
      stats.push(stat('total', label, num(a.value, prefs)));
      if (f?.latest)
        stats.push(
          stat(
            'latest',
            latestLabel,
            a.canOpenChallenge ? f.latest.name : 'A challenge',
            `Ended ${day(f.latest.date)}`,
            a.canOpenChallenge ? `/c/${f.latest.id}` : null,
          ),
        );
      if (maxed) break;
      const gap = Math.ceil(target - a.value);
      next = there(a.value) ? landing : `${gap} more ${gap === 1 ? one : many} ${reach}${by}.`;
      break;
    }
    case 'social': {
      const label = SOCIAL_LABEL[rule.event];
      stats.push(stat('total', label, num(a.value, prefs)));
      if (maxed) break;
      const gap = Math.ceil(target - a.value);
      next = there(a.value) ? landing : `${gap} more ${lowerFirst(label)} ${reach}${by}.`;
      break;
    }
    case 'date_active': {
      const f = a.facts?.type === 'date_active' ? a.facts : null;
      const dm = dayMonth(rule.month, rule.day, prefs);
      stats.push(
        stat(
          'years',
          `Years active on ${dm}`,
          count(a.value, 'year', prefs),
          f?.latestDate ? `Latest ${day(f.latestDate)}` : null,
        ),
      );
      if (maxed) break;
      const gap = Math.ceil(target - a.value);
      const need = metricAtLeast(rule.metric, rule.min, prefs);
      next = there(a.value)
        ? landing
        : gap === 1
          ? `${cap(need)} on ${dm} ${reach}${by}.`
          : `${gap} more years of ${need} on ${dm} ${reach}${by}.`;
      break;
    }
  }

  if (next && a.window && today > a.window.end)
    next = `This limited-time badge ended on ${day(a.window.end)}.`;
  return { stats, next };
}

/** "Log sleep" / "Get 10,000 steps": what keeps a streak going today. */
function streakAction(rule: Extract<BadgeRule, { type: 'streak' }>, prefs: Prefs): string {
  if (rule.min <= 1)
    return `Log ${rule.metric === 'sleep' ? 'sleep' : badgeMetricLabel(rule.metric)}`;
  return `Get ${metricAmount(rule.metric, rule.min, prefs)}`;
}
