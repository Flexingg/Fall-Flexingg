/**
 * The `propose_badge` tool Claude must call, as a JSON schema written by hand to mirror
 * badgeRuleSchema. Enum lists come from the exported constants so they can't drift; a unit test
 * checks every rule type in badgeRuleSchema has an entry here. The answer is still validated with
 * badgeDraftSchema afterwards: this schema only steers the model.
 */
import {
  ACTIVITY_MEASURES,
  ACTIVITY_SPORTS,
  BADGE_DAY_METRICS,
  BADGE_FAMILIES,
  BADGE_ICONS,
  CHALLENGE_DRAMA,
  SOCIAL_EVENTS,
} from '@gauntlet/shared';

export const TOOL_NAME = 'propose_badge';

type Schema = Record<string, unknown>;

const tiers: Schema = {
  type: 'array',
  minItems: 1,
  maxItems: 4,
  items: { type: 'number', exclusiveMinimum: 0 },
  description: 'Thresholds for up to four tiers (bronze to platinum), strictly increasing.',
};
const metric: Schema = {
  type: 'string',
  description: `One of: ${BADGE_DAY_METRICS.join(', ')}; or "lift_max:<exercise name>" / "lift_e1rm:<exercise name>" for one lift.`,
};
const min = (what: string): Schema => ({ type: 'number', exclusiveMinimum: 0, description: what });
const hours: Schema = {
  type: 'object',
  description: 'Local hour range [from, to); wraps past midnight when from > to.',
  properties: {
    from: { type: 'integer', minimum: 0, maximum: 23 },
    to: { type: 'integer', minimum: 1, maximum: 24 },
  },
  required: ['from', 'to'],
};
const sport: Schema = { type: 'string', enum: [...ACTIVITY_SPORTS] };
const measure: Schema = {
  type: 'string',
  enum: [...ACTIVITY_MEASURES],
  description: 'Distances are in kilometres, durations in minutes.',
};
const kind = (t: string): Schema => ({ type: 'string', enum: [t] });

/** One entry per rule type, keyed by the rule's `type`. */
export const RULE_SCHEMAS: Record<string, Schema> = {
  lifetime_total: {
    type: 'object',
    description: 'A metric added up over all time (or the badge window). "Walk 1,000,000 steps".',
    properties: { type: kind('lifetime_total'), metric, tiers },
    required: ['type', 'metric', 'tiers'],
  },
  best_period: {
    type: 'object',
    description: 'Best single day, week (Mon-Sun) or month total. "A 30,000-step day".',
    properties: {
      type: kind('best_period'),
      metric,
      period: { type: 'string', enum: ['day', 'week', 'month'] },
      tiers,
    },
    required: ['type', 'metric', 'period', 'tiers'],
  },
  streak: {
    type: 'object',
    description: 'Consecutive days with the metric at or above min. Tiers are streak lengths.',
    properties: { type: kind('streak'), metric, min: min('Daily minimum'), tiers },
    required: ['type', 'metric', 'min', 'tiers'],
  },
  count_days: {
    type: 'object',
    description: 'Number of days (not necessarily in a row) with the metric at or above min.',
    properties: {
      type: kind('count_days'),
      metric,
      min: min('Daily minimum'),
      tiers,
      hours,
    },
    required: ['type', 'metric', 'min', 'tiers'],
  },
  single_activity: {
    type: 'object',
    description: 'One activity reaching a size. "A 10 km run". Tiers are sizes of one activity.',
    properties: { type: kind('single_activity'), sport, measure, tiers, hours },
    required: ['type', 'sport', 'measure', 'tiers'],
  },
  activity_count: {
    type: 'object',
    description:
      'How many activities, optionally only those of at least `min` of `measure`. "50 runs of 5 km or more".',
    properties: {
      type: kind('activity_count'),
      sport,
      tiers,
      measure,
      min: min('Minimum size of each counted activity, in the measure'),
      hours,
    },
    required: ['type', 'sport', 'tiers'],
  },
  activity_total: {
    type: 'object',
    description: 'Activity amounts added up. "Ride 100 km" (usually inside a window).',
    properties: { type: kind('activity_total'), sport, measure, tiers },
    required: ['type', 'sport', 'measure', 'tiers'],
  },
  challenge_result: {
    type: 'object',
    description: 'Finished group challenges. Tiers count how many matched.',
    properties: {
      type: kind('challenge_result'),
      place: { type: 'integer', enum: [1, 3], description: '1 = won, 3 = podium.' },
      minParticipants: { type: 'integer', minimum: 2 },
      teamOnly: { type: 'boolean' },
      drama: { type: 'string', enum: [...CHALLENGE_DRAMA] },
      tiers,
    },
    required: ['type', 'tiers'],
  },
  social: {
    type: 'object',
    description: 'Counting social things people do in Gauntlet.',
    properties: {
      type: kind('social'),
      event: { type: 'string', enum: [...SOCIAL_EVENTS] },
      tiers,
    },
    required: ['type', 'event', 'tiers'],
  },
  date_active: {
    type: 'object',
    description: "Active on a calendar date, every year (e.g. New Year's Day).",
    properties: {
      type: kind('date_active'),
      month: { type: 'integer', minimum: 1, maximum: 12 },
      day: { type: 'integer', minimum: 1, maximum: 31 },
      metric,
      min: min('Minimum for the metric that day (default 1000 steps)'),
    },
    required: ['type', 'month', 'day'],
  },
};

export function buildProposeBadgeTool() {
  return {
    name: TOOL_NAME,
    description:
      'Decide whether Gauntlet can faithfully offer a badge inspired by this Garmin badge, and if so draft an original one.',
    input_schema: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['match', 'skip'] },
        reason: {
          type: 'string',
          description: 'One short sentence: why it matches, or why it is skipped.',
        },
        draft: {
          type: 'object',
          description: 'Required when decision is "match".',
          properties: {
            key: {
              type: 'string',
              description: 'g-<slug>-<garmin id>, lowercase letters, digits and dashes.',
            },
            name: { type: 'string', minLength: 2, maxLength: 40 },
            description: {
              type: 'string',
              minLength: 4,
              maxLength: 160,
              description: 'One plain sentence on what to do. "{n}" stands for the tier threshold.',
            },
            family: { type: 'string', enum: [...BADGE_FAMILIES] },
            icon: { type: 'string', enum: [...BADGE_ICONS] },
            secret: { type: 'boolean' },
            rule: { anyOf: Object.values(RULE_SCHEMAS) },
            window: {
              description: 'Only for limited-time badges: the source dates. Otherwise null.',
              anyOf: [
                { type: 'null' },
                {
                  type: 'object',
                  properties: {
                    start: { type: 'string', description: 'YYYY-MM-DD' },
                    end: { type: 'string', description: 'YYYY-MM-DD' },
                  },
                  required: ['start', 'end'],
                },
              ],
            },
            countsManual: {
              type: 'boolean',
              description: 'Whether manually entered data may count (normally true).',
            },
          },
          required: [
            'key',
            'name',
            'description',
            'family',
            'icon',
            'secret',
            'rule',
            'window',
            'countsManual',
          ],
        },
      },
      required: ['decision', 'reason'],
    },
  };
}
