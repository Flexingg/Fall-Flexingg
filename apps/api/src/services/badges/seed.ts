/**
 * The launch badges: about forty built-in definitions, written as data like any admin-made badge.
 * seedBadges() runs at startup: it adds missing ones (live), refreshes the wording/icon of built-ins
 * nobody has customised, and bumps the version of one whose rule changed. A new or changed rule is
 * backfilled for everyone in the background, quietly. Badges made by admins or imported from Garmin
 * are never touched, and neither is a built-in an admin has edited or retired.
 */
import { badgeDraftSchema, type BadgeDraft } from '@gauntlet/shared';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { badgeDefinitions } from '../../db/schema.js';
import { backfillBadge, stableJson } from './engine.js';
import { runInBackground } from './tasks.js';

type Seed = Omit<BadgeDraft, 'imageUrl' | 'window' | 'xp' | 'countsManual' | 'secret'> &
  Partial<Pick<BadgeDraft, 'secret' | 'countsManual'>>;

const s = (
  key: string,
  name: string,
  family: BadgeDraft['family'],
  icon: BadgeDraft['icon'],
  description: string,
  rule: BadgeDraft['rule'],
  extra: Partial<Pick<BadgeDraft, 'secret' | 'countsManual'>> = {},
): Seed => ({ key, name, family, icon, description, rule, ...extra });

export const BUILTIN_BADGES: Seed[] = [
  // Movement
  s('long-haul', 'Long Haul', 'movement', 'shoe', 'Walk {n} steps in total.', {
    type: 'lifetime_total',
    metric: 'steps',
    tiers: [100_000, 1_000_000, 5_000_000, 10_000_000],
  }),
  s('far-out', 'Far Out', 'movement', 'route', 'Cover {n} in total, any way you like.', {
    type: 'lifetime_total',
    metric: 'distance',
    tiers: [100, 1000, 5000, 10000],
  }),
  s('show-up', 'Show Up', 'movement', 'flame', 'Log {n} workouts.', {
    type: 'lifetime_total',
    metric: 'workouts',
    tiers: [10, 100, 500, 1000],
  }),
  s('mile-eater', 'Mile Eater', 'movement', 'run', 'Run {n} in total.', {
    type: 'activity_total',
    sport: 'run',
    measure: 'distance_km',
    tiers: [100, 500, 2000, 5000],
  }),
  s('wheelhouse', 'Wheelhouse', 'movement', 'bike', 'Ride {n} in total.', {
    type: 'activity_total',
    sport: 'ride',
    measure: 'distance_km',
    tiers: [100, 500, 2000, 5000],
  }),
  s('make-a-splash', 'Make a Splash', 'movement', 'wave', 'Go for {n} swims.', {
    type: 'activity_count',
    sport: 'swim',
    tiers: [10, 50, 100],
  }),
  s('trail-mix', 'Trail Mix', 'movement', 'mountain', 'Head out on {n} hikes.', {
    type: 'activity_count',
    sport: 'hike',
    tiers: [5, 25, 100],
  }),
  s('inner-calm', 'Inner Calm', 'movement', 'leaf', 'Do {n} yoga or pilates sessions.', {
    type: 'activity_count',
    sport: 'yoga',
    tiers: [10, 50, 100],
  }),

  // Big days
  s('big-day-out', 'Big Day Out', 'big_days', 'rocket', 'Reach {n} steps in a single day.', {
    type: 'best_period',
    metric: 'steps',
    period: 'day',
    tiers: [20_000, 30_000, 40_000, 50_000],
  }),
  s('week-to-remember', 'Week to Remember', 'big_days', 'calendar', 'Take {n} steps in one week.', {
    type: 'best_period',
    metric: 'steps',
    period: 'week',
    tiers: [70_000, 100_000, 150_000],
  }),
  s('sweat-equity', 'Sweat Equity', 'big_days', 'timer', 'Be active for {n} minutes in one day.', {
    type: 'best_period',
    metric: 'active_minutes',
    period: 'day',
    tiers: [90, 180, 300],
  }),
  s('pavement-poet', 'Pavement Poet', 'big_days', 'run', 'Run {n} in one go.', {
    type: 'single_activity',
    sport: 'run',
    measure: 'distance_km',
    tiers: [5, 10, 21.1, 42.2],
  }),
  s('wheel-deal', 'Wheel Deal', 'big_days', 'bike', 'Ride {n} in a single ride.', {
    type: 'single_activity',
    sport: 'ride',
    measure: 'distance_km',
    tiers: [25, 50, 100, 160],
  }),

  // Consistency
  s('never-miss', 'Never Miss', 'consistency', 'streak', 'Hit 10,000 steps {n} days in a row.', {
    type: 'streak',
    metric: 'steps',
    min: 10_000,
    tiers: [7, 30, 100, 365],
  }),
  s('ten-grand-club', 'Ten Grand Club', 'consistency', 'steps', 'Hit 10,000 steps on {n} days.', {
    type: 'count_days',
    metric: 'steps',
    min: 10_000,
    tiers: [30, 100, 365, 730],
  }),
  s(
    'habit-forming',
    'Habit Forming',
    'consistency',
    'heart',
    'Get 30+ active minutes on {n} days.',
    {
      type: 'count_days',
      metric: 'active_minutes',
      min: 30,
      tiers: [30, 100, 250, 500],
    },
  ),
  s('well-rested', 'Well Rested', 'consistency', 'moon', 'Sleep 7+ hours on {n} nights.', {
    type: 'count_days',
    metric: 'sleep',
    min: 7,
    tiers: [30, 100, 365],
  }),

  // Competition
  s('victory-lap', 'Victory Lap', 'competition', 'trophy', 'Win {n} group challenges.', {
    type: 'challenge_result',
    place: 1,
    tiers: [1, 5, 25, 100],
  }),
  s(
    'podium-regular',
    'Podium Regular',
    'competition',
    'podium',
    'Finish top three in {n} group challenges.',
    {
      type: 'challenge_result',
      place: 3,
      tiers: [10],
    },
  ),
  s(
    'big-fish',
    'Big Fish',
    'competition',
    'crown',
    'Win a challenge against four or more rivals.',
    {
      type: 'challenge_result',
      place: 1,
      minParticipants: 5,
      tiers: [1],
    },
  ),

  // Drama
  s(
    'comeback-kid',
    'Comeback Kid',
    'drama',
    'rocket',
    'Win a challenge after being dead last at the halfway mark.',
    {
      type: 'challenge_result',
      drama: 'comeback',
      tiers: [1],
    },
  ),
  s(
    'photo-finish',
    'Photo Finish',
    'drama',
    'stopwatch',
    'Win a challenge by less than one percent.',
    {
      type: 'challenge_result',
      drama: 'photo_finish',
      tiers: [1],
    },
  ),
  s(
    'wire-to-wire',
    'Wire to Wire',
    'drama',
    'flag',
    'Lead a challenge from the first day to the last, and win it.',
    {
      type: 'challenge_result',
      drama: 'wire_to_wire',
      tiers: [1],
    },
  ),
  s(
    'giant-killer',
    'Giant Killer',
    'drama',
    'swords',
    'Beat someone who normally outpaces you three to one.',
    {
      type: 'challenge_result',
      drama: 'giant_killer',
      tiers: [1],
    },
  ),

  // Rivalry
  s('rematch-royalty', 'Rematch Royalty', 'rivalry', 'shield', 'Win {n} rematches.', {
    type: 'social',
    event: 'rematches_won',
    tiers: [1, 5, 10],
  }),
  s('good-sport', 'Good Sport', 'rivalry', 'handshake', 'Pay up on {n} side bets you lost.', {
    type: 'social',
    event: 'stakes_paid',
    tiers: [1, 5, 20],
  }),

  // Social
  s('biggest-fan', 'Biggest Fan', 'social', 'clap', 'Cheer on {n} posts from other people.', {
    type: 'social',
    event: 'reactions_sent',
    tiers: [10, 50, 250, 1000],
  }),
  s('instigator', 'Instigator', 'social', 'flag', 'Start {n} group challenges.', {
    type: 'social',
    event: 'challenges_created',
    tiers: [1, 10, 50],
  }),
  s(
    'recruiter',
    'Recruiter',
    'social',
    'handshake',
    'Get {n} people into a challenge with your invite.',
    {
      type: 'social',
      event: 'invite_joins',
      tiers: [1, 5, 20],
    },
  ),
  s('team-player', 'Team Player', 'social', 'party', 'Join {n} team challenges.', {
    type: 'social',
    event: 'team_challenges_joined',
    tiers: [1, 10],
  }),
  s('squad-goals', 'Squad Goals', 'social', 'heart', 'Make {n} friends on Gauntlet.', {
    type: 'social',
    event: 'friends',
    tiers: [3, 10, 25],
  }),

  // Strength
  s('iron-tonnage', 'Iron Tonnage', 'strength', 'barbell', 'Lift {n} in total.', {
    type: 'lifetime_total',
    metric: 'lift_volume',
    tiers: [1000, 10_000, 100_000, 1_000_000],
  }),
  s('gym-rat', 'Gym Rat', 'strength', 'dumbbell', 'Log lifting on {n} days.', {
    type: 'count_days',
    metric: 'lift_sets',
    min: 1,
    tiers: [10, 50, 100, 250],
  }),
  s('record-breaker', 'Record Breaker', 'strength', 'medal', 'Set {n} personal records.', {
    type: 'social',
    event: 'personal_records',
    tiers: [1, 10, 50, 100],
  }),

  // Fasting
  s('fast-friend', 'Fast Friend', 'fasting', 'hourglass', 'Complete {n} fasts.', {
    type: 'lifetime_total',
    metric: 'fasts_completed',
    tiers: [10, 50, 100, 365],
  }),
  s('day-without', 'Day Without', 'fasting', 'timer', 'Fast for a full 24 hours.', {
    type: 'best_period',
    metric: 'fast_hours',
    period: 'day',
    tiers: [24],
  }),

  // Secret
  s(
    'night-owl',
    'Night Owl',
    'secret',
    'owl',
    'Start 10 workouts between midnight and 4 am.',
    {
      type: 'activity_count',
      sport: 'any',
      hours: { from: 0, to: 4 },
      tiers: [10],
    },
    { secret: true, countsManual: false },
  ),
  s(
    'early-bird',
    'Early Bird',
    'secret',
    'sunrise',
    'Start 10 workouts between 4 and 6 am.',
    {
      type: 'activity_count',
      sport: 'any',
      hours: { from: 4, to: 6 },
      tiers: [10],
    },
    { secret: true, countsManual: false },
  ),
  s(
    'new-year-same-me',
    'New Year, Same Me',
    'secret',
    'party',
    "Get moving on New Year's Day.",
    {
      type: 'date_active',
      month: 1,
      day: 1,
      metric: 'steps',
      min: 1000,
    },
    { secret: true },
  ),
  s(
    'leap-of-faith',
    'Leap of Faith',
    'secret',
    'sparkle',
    'Get moving on a leap day.',
    {
      type: 'date_active',
      month: 2,
      day: 29,
      metric: 'steps',
      min: 1000,
    },
    { secret: true },
  ),
  s(
    'perfect-week',
    'Perfect Week',
    'secret',
    'drop',
    'Hit your water goal seven days running.',
    {
      type: 'streak',
      metric: 'water_goal',
      min: 100,
      tiers: [7],
    },
    { secret: true },
  ),
];

/** Fully-formed drafts (defaults applied and validated); throws if a seed is malformed. */
export function builtinDrafts(): BadgeDraft[] {
  return BUILTIN_BADGES.map((b) => badgeDraftSchema.parse({ ...b, imageUrl: null }));
}

const ruleSig = (d: { rule: unknown; window: unknown; countsManual: boolean }) =>
  stableJson([d.rule, d.window, d.countsManual]);

/**
 * Bring the built-in badges up to date. Returns the keys that were added or whose rule changed
 * (those are backfilled in the background).
 */
export async function seedBadges(ctx: AppContext): Promise<string[]> {
  const drafts = builtinDrafts();
  const existing = new Map((await ctx.db.select().from(badgeDefinitions)).map((d) => [d.key, d]));
  const toBackfill: string[] = [];
  for (const [position, d] of drafts.entries()) {
    const row = existing.get(d.key);
    const cols = {
      name: d.name,
      description: d.description,
      family: d.family,
      icon: d.icon,
      secret: d.secret,
      rule: d.rule,
      windowStart: d.window?.start ?? null,
      windowEnd: d.window?.end ?? null,
      xp: d.xp,
      countsManual: d.countsManual,
      position,
    };
    if (!row) {
      const [added] = await ctx.db
        .insert(badgeDefinitions)
        .values({
          key: d.key,
          ...cols,
          imageUrl: null,
          status: 'live',
          origin: 'builtin',
          publishedAt: ctx.now(),
        })
        .onConflictDoNothing()
        .returning({ key: badgeDefinitions.key });
      if (added) toBackfill.push(d.key);
      continue;
    }
    if (row.origin !== 'builtin' || row.customized) continue;
    const changed =
      ruleSig(d) !==
      ruleSig({
        rule: row.rule,
        window:
          row.windowStart && row.windowEnd ? { start: row.windowStart, end: row.windowEnd } : null,
        countsManual: row.countsManual,
      });
    await ctx.db
      .update(badgeDefinitions)
      .set({
        ...cols,
        version: changed ? row.version + 1 : row.version,
        updatedAt: changed ? ctx.now() : row.updatedAt,
      })
      .where(eq(badgeDefinitions.key, d.key));
    if (changed && row.status === 'live') toBackfill.push(d.key);
  }
  if (toBackfill.length)
    runInBackground(ctx, 'launch badge backfill', async () => {
      for (const key of toBackfill) await backfillBadge(ctx, key);
    });
  return toBackfill;
}
