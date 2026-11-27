/**
 * Plain-English wording for badge rules, used by Admin → Badges so nobody has to read JSON:
 * "Lifetime steps: 100k · 1M · 5M · 10M". Pure and unit-free of the viewer's preferences (admins
 * see one neutral rendering), so it lives in shared next to the rule schema it describes.
 */
import {
  ACTIVITY_SPORTS,
  type ActivityMeasure,
  type ActivitySport,
  type BadgeRule,
  type BadgeDraft,
  type ChallengeDrama,
  type SocialEvent,
} from './badges.js';
import { metricDef, type MetricKey } from './metrics.js';
import { compactNumber } from './review.js';

/** compactNumber, but keeping a decimal on small values (21.1 km stays 21.1). */
const short = (n: number) =>
  Math.abs(n) < 1000 ? String(Math.round(n * 10) / 10) : compactNumber(n);

/** Friendly names for the daily metrics a rule may read. */
export const BADGE_METRIC_LABELS: Record<string, string> = {
  steps: 'steps',
  distance: 'distance',
  active_minutes: 'active minutes',
  active_calories: 'active calories',
  workouts: 'workouts',
  sleep: 'hours of sleep',
  lift_volume: 'weight lifted',
  lift_sets: 'working sets',
  water: 'water',
  water_goal: 'water goal %',
  calorie_adherence: 'calorie goal points',
  fast_hours: 'hours fasted',
  fasts_completed: 'fasts completed',
};

/** "Steps" for a metric key, or "Bench Press max weight" for lift_max:Bench Press. */
export function badgeMetricLabel(metric: string): string {
  const lift = /^lift_(max|e1rm):(.+)$/.exec(metric);
  if (lift) return `${lift[2]} ${lift[1] === 'max' ? 'heaviest lift' : 'estimated 1-rep max'}`;
  return BADGE_METRIC_LABELS[metric] ?? metric.replace(/_/g, ' ');
}

const unitOf = (metric: string): string => {
  if (/^lift_/.test(metric)) return 'kg';
  try {
    return metricDef(metric as MetricKey).unit;
  } catch {
    return '';
  }
};

/** 1500 -> "1.5k", with a unit when it reads naturally ("5 km", "40 kg"). */
function amount(n: number, unit = ''): string {
  const v = short(n);
  return unit === 'km' || unit === 'kg' || unit === 'L' || unit === 'h' || unit === 'min'
    ? `${v} ${unit}`
    : unit === '%' || unit === 'pts'
      ? `${v}${unit === '%' ? '%' : ' points'}`
      : v;
}

const list = (tiers: number[], unit = '') => tiers.map((t) => amount(t, unit)).join(' · ');

export const SPORT_LABEL: Record<ActivitySport, string> = {
  any: 'activities',
  run: 'runs',
  walk: 'walks',
  hike: 'hikes',
  ride: 'rides',
  swim: 'swims',
  strength: 'strength sessions',
  yoga: 'yoga sessions',
  cardio: 'cardio sessions',
  other: 'other workouts',
};
export const SPORT_ONE: Record<ActivitySport, string> = {
  any: 'activity',
  run: 'run',
  walk: 'walk',
  hike: 'hike',
  ride: 'ride',
  swim: 'swim',
  strength: 'strength session',
  yoga: 'yoga session',
  cardio: 'cardio session',
  other: 'workout',
};
const MEASURE_UNIT: Record<ActivityMeasure, string> = {
  distance_km: 'km',
  minutes: 'min',
  kcal: 'kcal',
};
export const SOCIAL_LABEL: Record<SocialEvent, string> = {
  reactions_sent: 'Reactions sent',
  comments_sent: 'Comments sent',
  challenges_created: 'Challenges created',
  challenges_joined: 'Challenges joined',
  team_challenges_joined: 'Team challenges joined',
  friends: 'Friends made',
  invite_joins: 'People who joined through your invites',
  stakes_paid: 'Side bets paid',
  rematches_won: 'Rematches won',
  personal_records: 'Personal records set',
};
export const DRAMA_LABEL: Record<ChallengeDrama, string> = {
  comeback: 'Come-from-behind wins',
  photo_finish: 'Photo-finish wins',
  wire_to_wire: 'Wins from the first day to the last',
  giant_killer: 'Wins over a much stronger field',
};

const hourText = (h: number) =>
  `${h === 0 || h === 24 ? 12 : h > 12 ? h - 12 : h}${h >= 12 && h < 24 ? ' pm' : ' am'}`;
export const hoursText = (r?: { from: number; to: number }) =>
  r ? `, between ${hourText(r.from)} and ${hourText(r.to)}` : '';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "1 Jul – 31 Aug 2026" style, from two ISO dates. */
export function describeWindow(w: { start: string; end: string }): string {
  const f = (d: string) =>
    `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]!.slice(0, 3)}`;
  return `${f(w.start)} to ${f(w.end)} ${w.end.slice(0, 4)}`;
}

/** One line saying what earns the badge, e.g. "Lifetime steps: 100k · 1M · 5M · 10M". */
export function describeRule(
  rule: BadgeRule,
  window?: { start: string; end: string } | null,
): string {
  let text: string;
  switch (rule.type) {
    case 'lifetime_total': {
      const u = unitOf(rule.metric);
      text = `${window ? 'Total' : 'Lifetime'} ${badgeMetricLabel(rule.metric)}: ${list(rule.tiers, u)}`;
      break;
    }
    case 'best_period':
      text = `Best ${rule.period} of ${badgeMetricLabel(rule.metric)}: ${list(rule.tiers, unitOf(rule.metric))}`;
      break;
    case 'streak':
      text = `Days in a row with ${amount(rule.min, unitOf(rule.metric))}+ ${badgeMetricLabel(rule.metric)}: ${list(rule.tiers)}`;
      break;
    case 'count_days':
      text = `Days with ${amount(rule.min, unitOf(rule.metric))}+ ${badgeMetricLabel(rule.metric)}${hoursText(rule.hours)}: ${list(rule.tiers)}`;
      break;
    case 'single_activity':
      text = `One ${SPORT_ONE[rule.sport]}${hoursText(rule.hours)}, biggest ${rule.measure === 'distance_km' ? 'distance' : rule.measure === 'minutes' ? 'time' : 'calories'}: ${list(rule.tiers, MEASURE_UNIT[rule.measure])}`;
      break;
    case 'activity_count': {
      const big =
        rule.measure && rule.min ? ` of ${amount(rule.min, MEASURE_UNIT[rule.measure])}+` : '';
      text = `Number of ${SPORT_LABEL[rule.sport]}${big}${hoursText(rule.hours)}: ${list(rule.tiers)}`;
      break;
    }
    case 'activity_total':
      text = `Total ${rule.measure === 'distance_km' ? 'distance' : rule.measure === 'minutes' ? 'time' : 'calories'} across ${SPORT_LABEL[rule.sport]}: ${list(rule.tiers, MEASURE_UNIT[rule.measure])}`;
      break;
    case 'challenge_result': {
      const what = rule.drama
        ? DRAMA_LABEL[rule.drama]
        : rule.place === 1
          ? 'Challenges won'
          : rule.place === 3
            ? 'Podium finishes'
            : 'Challenges finished';
      const extra = [
        rule.teamOnly ? 'team challenges only' : null,
        rule.minParticipants ? `${rule.minParticipants}+ people` : null,
      ].filter(Boolean);
      text = `${what}${extra.length ? ` (${extra.join(', ')})` : ''}: ${list(rule.tiers)}`;
      break;
    }
    case 'social':
      text = `${SOCIAL_LABEL[rule.event]}: ${list(rule.tiers)}`;
      break;
    case 'date_active':
      text = `Active on ${rule.day} ${MONTHS[rule.month - 1]}: ${amount(rule.min, unitOf(rule.metric))}+ ${badgeMetricLabel(rule.metric)}`;
      break;
  }
  return window ? `${text} (${describeWindow(window)})` : text;
}

/** Same, from a whole draft. */
export const describeDraft = (d: Pick<BadgeDraft, 'rule' | 'window'>) =>
  describeRule(d.rule, d.window);

/** The sports a rule can name, in the order the editor lists them. */
export const SPORT_CHOICES: { value: ActivitySport; label: string }[] = ACTIVITY_SPORTS.map(
  (value) => ({ value, label: value === 'any' ? 'Any activity' : SPORT_ONE[value] }),
);

/** Whole days from `today` to the end of a window, counting today; 0 once it has ended. */
export function daysLeftInWindow(window: { end: string }, today: string): number {
  const a = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10));
  const b = Date.UTC(
    +window.end.slice(0, 4),
    +window.end.slice(5, 7) - 1,
    +window.end.slice(8, 10),
  );
  return Math.max(0, Math.round((b - a) / 86_400_000) + 1);
}
