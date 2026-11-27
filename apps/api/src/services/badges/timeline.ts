/**
 * A person's badge timeline (newest first, by the day each tier was really earned) and the XP race
 * against friends. Both are built from the same earned rows as users.badge_xp: every row whose
 * badge definition still exists counts for xpForTier(...) exactly like recomputeXp, so a person's
 * line in the race always ends at their level XP.
 *
 * Privacy is decided by the caller (badgeTargetFor); the race only draws friends who can be seen
 * and share their stats, plus you.
 */
import {
  XP_RACE_RANGES,
  addDays,
  daysBetween,
  ruleTiers,
  tierName,
  todayIn,
  xpForTier,
  type BadgeIcon,
  type BadgeTimelineEntry,
  type BadgeTimelineResponse,
  type XpRaceRange,
  type XpRaceResponse,
} from '@gauntlet/shared';
import { eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { HttpError } from '../../context.js';
import { badgeDefinitions, userBadges } from '../../db/schema.js';
import { displayFor } from '../display.js';
import { friendIds } from '../friends.js';
import { canSeeUser } from '../privacy.js';
import { getUser, getUsers, toPublicUser } from '../users.js';
import { challengeAccess, describeEarn, earnedDay } from './earned.js';

/** Newest first: real day, then when it was recorded, then a fixed tie-break. */
function newerFirst(
  a: { date: string; at: number; key: string; tier: number },
  b: { date: string; at: number; key: string; tier: number },
): number {
  return (
    b.date.localeCompare(a.date) || b.at - a.at || a.key.localeCompare(b.key) || b.tier - a.tier
  );
}

interface Cursor {
  date: string;
  at: number;
  key: string;
  tier: number;
}

const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(v: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(v, 'base64url').toString('utf8')) as Cursor;
    if (
      typeof c.date === 'string' &&
      typeof c.at === 'number' &&
      typeof c.key === 'string' &&
      typeof c.tier === 'number'
    )
      return c;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'That page marker is not valid.', 'bad_cursor');
}

export async function buildTimeline(
  ctx: AppContext,
  viewerId: string,
  targetId: string,
  opts: { before?: string; limit: number },
): Promise<BadgeTimelineResponse> {
  const [viewer, target, prefs] = await Promise.all([
    getUser(ctx, viewerId),
    getUser(ctx, targetId),
    displayFor(ctx, viewerId),
  ]);
  const own = viewerId === targetId;
  const rows = await ctx.db
    .select({ r: userBadges, d: badgeDefinitions })
    .from(userBadges)
    .innerJoin(badgeDefinitions, eq(badgeDefinitions.key, userBadges.badgeKey))
    .where(eq(userBadges.userId, targetId));
  // Drafts are never shown; a retired badge is, because it was earned.
  const all = rows
    .filter((x) => x.d.status !== 'draft')
    .map((x) => ({
      ...x,
      date: earnedDay(x.r, target.timezone),
      at: x.r.earnedAt.getTime(),
      key: x.r.badgeKey,
      tier: x.r.tier,
    }))
    .sort(newerFirst);
  const cursor = opts.before ? decodeCursor(opts.before) : null;
  const rest = cursor ? all.filter((x) => newerFirst(cursor, x) < 0) : all;
  const page = rest.slice(0, opts.limit);
  const thisYear = todayIn(viewer.timezone, ctx.now()).slice(0, 4);
  const canSee = challengeAccess(ctx, viewerId);
  const entries: BadgeTimelineEntry[] = [];
  for (const x of page) {
    const count = ruleTiers(x.d.rule).length;
    const e = await describeEarn(canSee, { own, rule: x.d.rule, row: x.r, prefs, thisYear });
    entries.push({
      key: x.d.key,
      name: x.d.name,
      icon: x.d.icon as BadgeIcon,
      imageUrl: x.d.imageUrl,
      tier: x.r.tier,
      tierCount: count,
      tierName: tierName(x.r.tier, count),
      xp: xpForTier(x.r.tier, count, x.d.secret, x.d.xp),
      date: x.date,
      how: e.how,
      to: e.to,
      backfilled: x.r.backfilled,
      secret: x.d.secret,
    });
  }
  const last = page[page.length - 1];
  return {
    user: toPublicUser(target),
    entries,
    nextCursor:
      last && rest.length > page.length
        ? encodeCursor({ date: last.date, at: last.at, key: last.key, tier: last.tier })
        : null,
  };
}

// ---------- XP race ----------

const TOP_FRIENDS = 7;
const RANGE_DAYS: Record<Exclude<XpRaceRange, 'all'>, number> = { '30d': 30, '90d': 90, '1y': 365 };
/** Beyond this many days "all time" is drawn weekly so the chart stays readable. */
const DAILY_LIMIT_DAYS = 400;

export const isRaceRange = (v: unknown): v is XpRaceRange =>
  (XP_RACE_RANGES as readonly string[]).includes(v as string);

/** XP per earned row, with the day it counts on (every row whose badge exists, as recomputeXp). */
async function xpEvents(ctx: AppContext, people: { id: string; timezone: string }[]) {
  const rows = await ctx.db
    .select({ r: userBadges, d: badgeDefinitions })
    .from(userBadges)
    .innerJoin(badgeDefinitions, eq(badgeDefinitions.key, userBadges.badgeKey))
    .where(
      inArray(
        userBadges.userId,
        people.map((p) => p.id),
      ),
    );
  const zone = new Map(people.map((p) => [p.id, p.timezone]));
  const by = new Map<string, { date: string; xp: number }[]>();
  for (const { r, d } of rows) {
    const list = by.get(r.userId) ?? [];
    list.push({
      date: earnedDay(r, zone.get(r.userId) ?? 'UTC'),
      xp: xpForTier(r.tier, ruleTiers(d.rule).length, d.secret, d.xp),
    });
    by.set(r.userId, list);
  }
  for (const list of by.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  return by;
}

export async function buildRace(
  ctx: AppContext,
  viewerId: string,
  range: XpRaceRange,
): Promise<XpRaceResponse> {
  const me = await getUser(ctx, viewerId);
  const today = todayIn(me.timezone, ctx.now());
  const friends = [...(await getUsers(ctx, await friendIds(ctx, viewerId))).values()];
  const eligible = [];
  for (const f of friends)
    if (f.shareProfileStats && (await canSeeUser(ctx, viewerId, f))) eligible.push(f);
  eligible.sort((a, b) => b.badgeXp - a.badgeXp || a.displayName.localeCompare(b.displayName));
  const shown = [me, ...eligible.slice(0, TOP_FRIENDS)].sort(
    (a, b) =>
      b.badgeXp - a.badgeXp ||
      Number(b.id === viewerId) - Number(a.id === viewerId) ||
      a.displayName.localeCompare(b.displayName),
  );
  const events = await xpEvents(ctx, shown);

  // The dates drawn: every day for a month to a year (and all time up to ~400 days), else weekly.
  const earliest = shown
    .map((u) => events.get(u.id)?.[0]?.date)
    .filter((x): x is string => !!x)
    .sort()[0];
  let start: string;
  if (range === 'all')
    start = earliest && earliest < addDays(today, -30) ? earliest : addDays(today, -30);
  else start = addDays(today, -(RANGE_DAYS[range] - 1));
  if (start > today) start = today;
  let dates: string[] = [];
  if (range === 'all' && daysBetween(start, today) > DAILY_LIMIT_DAYS) {
    // Weekly, counted back from today so the last point is today; one more to start from zero.
    for (let d = today; ; d = addDays(d, -7)) {
      dates.unshift(d);
      if (d <= start) break;
    }
  } else {
    for (let d = start; d <= today; d = addDays(d, 1)) dates.push(d);
  }

  const series: XpRaceResponse['series'] = [];
  const gained: number[] = [];
  shown.forEach((u, i) => {
    const list = events.get(u.id) ?? [];
    let idx = 0;
    let total = 0;
    const values: number[] = [];
    for (const date of dates) {
      // Dates later than today (an owner a day ahead of the viewer) count by the last point.
      while (idx < list.length && (list[idx]!.date <= date || date === today))
        total += list[idx++]!.xp;
      values.push(total);
    }
    // Before the first drawn day: what was already banked.
    const first = dates[0]!;
    const before = list.filter((e) => e.date < first).reduce((s, e) => s + e.xp, 0);
    series.push({ user: toPublicUser(u), rank: i + 1, isMe: u.id === viewerId, values });
    gained.push(total - before);
  });
  return {
    range,
    dates,
    series,
    truncated: eligible.length > TOP_FRIENDS,
    total: eligible.length + 1,
    gained,
  };
}
