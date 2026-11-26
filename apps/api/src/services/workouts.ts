/**
 * Workout lists and the workout detail view, read live from SparkyFitness when someone looks
 * (nothing is stored). Your own are always yours. Someone else's is shown only where Show Events
 * would already show it to you: a challenge you are both in with Show Events on, covering that
 * day, for a stat that lists that kind of workout, and only if they haven't made their workouts
 * private. Everything else is a plain 404, so nobody can tell a hidden workout from a missing one.
 */
import {
  addDays,
  eventKindsFor,
  liftExercise,
  minDate,
  todayIn,
  type WorkoutDetail,
  type WorkoutsResponse,
} from '@gauntlet/shared';
import { buildWorkouts, toSummary, type WorkoutFull } from '@gauntlet/sparky';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { notFound } from '../context.js';
import { challengeParticipants, challenges } from '../db/schema.js';
import { getUser, getUsers, sparkyToken, type UserRow } from './users.js';

const ID = /^(\d{4}-\d{2}-\d{2})\.([A-Za-z0-9_-]{1,80})$/;

async function entriesFor(ctx: AppContext, user: UserRow, start: string, end: string) {
  const { exerciseEntries } = await ctx.sparky.report(sparkyToken(ctx, user), start, end);
  return exerciseEntries;
}

/** Your own workouts over the last `days` days, newest first. */
export async function listOwnWorkouts(
  ctx: AppContext,
  userId: string,
  days: number,
): Promise<WorkoutsResponse> {
  const user = await getUser(ctx, userId);
  if (user.isDemo) return { workouts: [] };
  const today = todayIn(user.timezone, ctx.now());
  const start = addDays(today, -(days - 1));
  const entries = await entriesFor(ctx, user, start, today);
  return { workouts: buildWorkouts(entries, { start, end: today }).map(toSummary) };
}

/**
 * Challenges that let `viewer` see `owner`'s workouts on `date`: both joined, Show Events on, the
 * day already covered. Returns what each one lists (a per-exercise challenge lists only its lift).
 */
async function sharedEventChallenges(
  ctx: AppContext,
  viewerId: string,
  ownerId: string,
  date: string,
) {
  const mine = await ctx.db
    .select({ id: challenges.id })
    .from(challengeParticipants)
    .innerJoin(challenges, eq(challenges.id, challengeParticipants.challengeId))
    .where(
      and(
        eq(challengeParticipants.userId, viewerId),
        eq(challengeParticipants.state, 'joined'),
        eq(challenges.showEvents, true),
      ),
    );
  if (!mine.length) return [];
  const rows = await ctx.db
    .select({
      metric: challenges.metric,
      startDate: challenges.startDate,
      endDate: challenges.endDate,
      timezone: challenges.timezone,
    })
    .from(challengeParticipants)
    .innerJoin(challenges, eq(challenges.id, challengeParticipants.challengeId))
    .where(
      and(
        eq(challengeParticipants.userId, ownerId),
        eq(challengeParticipants.state, 'joined'),
        inArray(
          challengeParticipants.challengeId,
          mine.map((m) => m.id),
        ),
      ),
    );
  return rows.filter(
    (c) => date >= c.startDate && date <= minDate(c.endDate, todayIn(c.timezone, ctx.now())),
  );
}

/** One workout with its sets. Yours, or (404 unless Show Events would show it) someone else's. */
export async function getWorkout(
  ctx: AppContext,
  viewerId: string,
  id: string,
  ownerId?: string,
): Promise<WorkoutDetail> {
  const m = ID.exec(id);
  if (!m) throw notFound('Workout not found');
  const date = m[1]!;
  const isMe = !ownerId || ownerId === viewerId;
  const owner = isMe
    ? await getUser(ctx, viewerId)
    : (await getUsers(ctx, [ownerId!])).get(ownerId!);
  if (!owner || owner.isDemo) throw notFound('Workout not found');

  // For someone else: which stats' events may show this workout.
  let allowed: ReturnType<typeof eventKindsFor>[] = [];
  let lifts: string[] | 'any' = 'any';
  if (!isMe) {
    if (!owner.shareEvents) throw notFound('Workout not found');
    const shared = await sharedEventChallenges(ctx, viewerId, owner.id, date);
    allowed = shared.map((c) => eventKindsFor(c.metric));
    lifts = shared.flatMap((c) => {
      const lift = liftExercise(c.metric);
      return lift && eventKindsFor(c.metric).includes('lift') ? [lift.exercise] : [];
    });
    if (!allowed.length) throw notFound('Workout not found');
    // Any challenge that lists lift sessions in general shows every exercise.
    const general = shared.some(
      (c) => eventKindsFor(c.metric).includes('lift') && !liftExercise(c.metric),
    );
    if (general) lifts = 'any';
  }

  let found: WorkoutFull | undefined;
  try {
    const entries = await entriesFor(ctx, owner, date, date);
    found = buildWorkouts(entries, { start: date, end: date }).find((w) => w.id === id);
  } catch (err) {
    if (isMe) throw err;
    ctx.log.warn({ err: String(err), userId: owner.id }, 'workout: SparkyFitness unavailable');
    throw notFound('Workout not found');
  }
  if (!found) throw notFound('Workout not found');

  let workout = found;
  if (!isMe) {
    const kind = found.kind === 'strength' ? 'lift' : 'workout';
    if (!allowed.some((k) => k.includes(kind))) throw notFound('Workout not found');
    if (kind === 'lift' && lifts !== 'any') {
      const only = found.exercises.filter((x) => lifts.includes(x.name.toLowerCase()));
      if (!only.length) throw notFound('Workout not found');
      const volume = only.reduce((a, x) => a + x.volumeKg, 0);
      const sets = only.reduce((a, x) => a + x.sets.filter((t) => !t.warmup).length, 0);
      workout = {
        ...found,
        exercises: only,
        name: only.length === 1 ? only[0]!.name : found.name,
        // Totals cover only what the challenge lists.
        volumeKg: volume > 0 ? volume : null,
        minutes: null,
        kcal: null,
        summary: `${sets} ${sets === 1 ? 'set' : 'sets'}${volume > 0 ? ` · ${Math.round(volume).toLocaleString('en-US')} kg volume` : ''}`,
      };
    }
    // Source names and heart rate follow the "show my data sources" choice, as in the feed.
    if (!owner.shareWorkoutDetails) workout = { ...workout, source: null, avgHeartRate: null };
  }
  return {
    ...workout,
    owner: { id: owner.id, displayName: owner.displayName, isMe },
  };
}
