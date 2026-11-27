/**
 * The Admin → Badges editor's brains, without any React: the rule builder works on plain strings
 * (so half-typed numbers are fine), and these functions turn them into a real rule, back again, and
 * check the whole draft with the same schema the server uses, in plain words.
 */
import {
  badgeDraftSchema,
  type ActivityMeasure,
  type ActivitySport,
  type BadgeDraft,
  type BadgeRule,
  type BadgeRuleType,
  type ChallengeDrama,
  type SocialEvent,
} from '@gauntlet/shared';

export const RULE_TYPES: { value: BadgeRuleType; label: string; hint: string }[] = [
  { value: 'lifetime_total', label: 'Add up a total over time', hint: 'Like 1,000,000 steps' },
  { value: 'best_period', label: 'Best single day, week or month', hint: 'Like a 30,000-step day' },
  { value: 'streak', label: 'Days in a row', hint: 'Like 7 days of 10,000 steps' },
  {
    value: 'count_days',
    label: 'Number of days',
    hint: 'Not in a row, like 20 days of 30+ minutes',
  },
  { value: 'single_activity', label: 'One big workout', hint: 'Like a 10 km run' },
  { value: 'activity_count', label: 'Number of workouts', hint: 'Like 50 runs' },
  { value: 'activity_total', label: 'Total across workouts', hint: 'Like 100 km of riding' },
  {
    value: 'challenge_result',
    label: 'Challenge results',
    hint: 'Wins, podiums or dramatic finishes',
  },
  { value: 'social', label: 'Social things', hint: 'Like sending 50 reactions' },
  {
    value: 'date_active',
    label: 'Active on a certain date',
    hint: "Like moving on New Year's Day",
  },
];

export interface RuleFields {
  type: BadgeRuleType;
  /** A daily metric key, or "lift_max" / "lift_e1rm" with `lift` naming the exercise. */
  metric: string;
  lift: string;
  period: 'day' | 'week' | 'month';
  min: string;
  hoursOn: boolean;
  hoursFrom: string;
  hoursTo: string;
  sport: ActivitySport;
  measure: ActivityMeasure;
  /** activity_count: only count workouts of at least `min` of `measure`. */
  sized: boolean;
  place: '' | '1' | '3';
  minParticipants: string;
  teamOnly: boolean;
  drama: '' | ChallengeDrama;
  event: SocialEvent;
  month: string;
  day: string;
  tiers: string[];
}

export const TIERED: BadgeRuleType[] = [
  'lifetime_total',
  'best_period',
  'streak',
  'count_days',
  'single_activity',
  'activity_count',
  'activity_total',
  'challenge_result',
  'social',
];

export function defaultFields(type: BadgeRuleType): RuleFields {
  return {
    type,
    metric: 'steps',
    lift: '',
    period: 'day',
    min:
      type === 'date_active' ? '1000' : type === 'streak' || type === 'count_days' ? '10000' : '',
    hoursOn: false,
    hoursFrom: '0',
    hoursTo: '6',
    sport: 'run',
    measure: 'distance_km',
    sized: false,
    place: type === 'challenge_result' ? '1' : '',
    minParticipants: '',
    teamOnly: false,
    drama: '',
    event: 'reactions_sent',
    month: '1',
    day: '1',
    tiers: type === 'date_active' ? [] : [''],
  };
}

const num = (s: string) => (s.trim() === '' ? NaN : Number(s));
const opt = (s: string) => (s.trim() === '' ? undefined : Number(s));

/** What the form says as a rule object (not yet checked: the schema does that). */
export function fieldsToRule(f: RuleFields): Record<string, unknown> {
  const metric =
    f.metric === 'lift_max' || f.metric === 'lift_e1rm' ? `${f.metric}:${f.lift.trim()}` : f.metric;
  const tiers = f.tiers.filter((t, i) => i === 0 || t.trim() !== '').map(num);
  const hours = f.hoursOn ? { hours: { from: num(f.hoursFrom), to: num(f.hoursTo) } } : {};
  switch (f.type) {
    case 'lifetime_total':
      return { type: f.type, metric, tiers };
    case 'best_period':
      return { type: f.type, metric, period: f.period, tiers };
    case 'streak':
      return { type: f.type, metric, min: num(f.min), tiers };
    case 'count_days':
      return { type: f.type, metric, min: num(f.min), tiers, ...hours };
    case 'single_activity':
      return { type: f.type, sport: f.sport, measure: f.measure, tiers, ...hours };
    case 'activity_count':
      return {
        type: f.type,
        sport: f.sport,
        tiers,
        ...(f.sized ? { measure: f.measure, min: num(f.min) } : {}),
        ...hours,
      };
    case 'activity_total':
      return { type: f.type, sport: f.sport, measure: f.measure, tiers };
    case 'challenge_result':
      return {
        type: f.type,
        tiers,
        ...(f.place ? { place: Number(f.place) } : {}),
        ...(opt(f.minParticipants) !== undefined
          ? { minParticipants: opt(f.minParticipants) }
          : {}),
        ...(f.teamOnly ? { teamOnly: true } : {}),
        ...(f.drama ? { drama: f.drama } : {}),
      };
    case 'social':
      return { type: f.type, event: f.event, tiers };
    case 'date_active':
      return { type: f.type, month: num(f.month), day: num(f.day), metric, min: num(f.min) };
  }
}

/** Fill the form from an existing rule. */
export function ruleToFields(rule: BadgeRule): RuleFields {
  const f = defaultFields(rule.type);
  const r = rule as Record<string, unknown>;
  if (typeof r.metric === 'string') {
    const lift = /^(lift_(?:max|e1rm)):(.*)$/.exec(r.metric);
    if (lift) {
      f.metric = lift[1]!;
      f.lift = lift[2]!;
    } else f.metric = r.metric;
  }
  if (r.period) f.period = r.period as RuleFields['period'];
  if (r.min != null) f.min = String(r.min);
  if (r.sport) f.sport = r.sport as ActivitySport;
  if (r.measure) {
    f.measure = r.measure as ActivityMeasure;
    f.sized = rule.type === 'activity_count';
  }
  const h = r.hours as { from: number; to: number } | undefined;
  if (h) {
    f.hoursOn = true;
    f.hoursFrom = String(h.from);
    f.hoursTo = String(h.to);
  }
  if (rule.type === 'challenge_result') f.place = r.place ? (String(r.place) as '1' | '3') : '';
  if (r.minParticipants != null) f.minParticipants = String(r.minParticipants);
  if (r.teamOnly) f.teamOnly = true;
  if (r.drama) f.drama = r.drama as ChallengeDrama;
  if (r.event) f.event = r.event as SocialEvent;
  if (r.month != null) f.month = String(r.month);
  if (r.day != null) f.day = String(r.day);
  if (Array.isArray(r.tiers)) f.tiers = (r.tiers as number[]).map(String);
  return f;
}

export interface DraftForm {
  key: string;
  name: string;
  description: string;
  family: BadgeDraft['family'];
  icon: BadgeDraft['icon'];
  imageUrl: string | null;
  secret: boolean;
  countsManual: boolean;
  limited: boolean;
  windowStart: string;
  windowEnd: string;
  xp: string[];
  rule: RuleFields;
}

export function emptyForm(): DraftForm {
  return {
    key: '',
    name: '',
    description: '',
    family: 'movement',
    icon: 'star',
    imageUrl: null,
    secret: false,
    countsManual: true,
    limited: false,
    windowStart: '',
    windowEnd: '',
    xp: [],
    rule: defaultFields('lifetime_total'),
  };
}

export function draftToForm(d: BadgeDraft): DraftForm {
  return {
    key: d.key,
    name: d.name,
    description: d.description,
    family: d.family,
    icon: d.icon,
    imageUrl: d.imageUrl ?? null,
    secret: d.secret,
    countsManual: d.countsManual,
    limited: !!d.window,
    windowStart: d.window?.start ?? '',
    windowEnd: d.window?.end ?? '',
    xp: (d.xp ?? []).map(String),
    rule: ruleToFields(d.rule),
  };
}

export function formToRaw(f: DraftForm): Record<string, unknown> {
  const xp = f.xp.some((x) => x.trim() !== '')
    ? f.xp.map((x) => (x.trim() === '' ? 0 : Number(x)))
    : null;
  return {
    key: f.key.trim(),
    name: f.name,
    description: f.description,
    family: f.family,
    icon: f.icon,
    imageUrl: f.imageUrl,
    secret: f.secret,
    countsManual: f.countsManual,
    window: f.limited ? { start: f.windowStart, end: f.windowEnd } : null,
    xp,
    rule: fieldsToRule(f.rule),
  };
}

export type DraftErrors = Partial<
  Record<'key' | 'name' | 'description' | 'window' | 'xp' | 'rule' | 'family' | 'icon', string>
>;

function say(path: PropertyKey[], message: string, code: string): string {
  const field = String(path[0]);
  if (field === 'name') return 'The name needs 2 to 40 characters.';
  if (field === 'description') return 'Describe it in 4 to 160 characters.';
  if (field === 'key') return 'Use lowercase letters, digits and dashes, 2 to 64 characters.';
  if (field === 'window') return 'Pick a start and end date.';
  if (field === 'xp') return 'XP must be whole numbers from 0 to 1000.';
  if (field === 'rule') {
    if (message === 'Tiers must increase') return 'Each tier must be bigger than the one before.';
    if (message === 'Unknown metric') return 'Pick a metric, or type the exercise name.';
    if (path.includes('tiers')) return 'Give 1 to 4 tiers, each a number above zero.';
    if (path.includes('hours')) return 'Hours must be whole numbers from 0 to 24.';
    if (code === 'invalid_type') return 'Fill in every number the rule needs.';
    return 'Check the numbers in the rule: they must be above zero.';
  }
  return message;
}

export function validateDraft(
  f: DraftForm,
): { ok: true; draft: BadgeDraft } | { ok: false; errors: DraftErrors } {
  const raw = formToRaw(f);
  const parsed = badgeDraftSchema.safeParse(raw);
  const errors: DraftErrors = {};
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? 'rule') as keyof DraftErrors;
      errors[field] ??= say(issue.path, issue.message, issue.code);
    }
  if (f.limited && f.windowStart && f.windowEnd && f.windowEnd < f.windowStart)
    errors.window = 'The end date must be on or after the start date.';
  return Object.keys(errors).length || !parsed.success
    ? { ok: false, errors }
    : { ok: true, draft: parsed.data };
}

/** "Million Stepper" -> "million-stepper". */
export const keyFromName = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
