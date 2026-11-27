/**
 * Admin → Challenges: every challenge on the server in one list (running, upcoming, finished) with
 * who made it, how many are in, and who leads. Admins can open any of them read-only (see
 * assertCanView's admin bypass); this list only names people the way challenges already do.
 */
import type { AdminChallengeRow, AdminChallengesResponse } from '@gauntlet/shared';
import { inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { challengeParticipants, challenges } from '../db/schema.js';
import { challengeMetricDef, challengeStatus } from './challenges.js';
import { getUsers } from './users.js';

export async function listAdminChallenges(
  ctx: AppContext,
  opts: { status: 'running' | 'upcoming' | 'finished' | 'all'; q?: string },
): Promise<AdminChallengesResponse> {
  const all = await ctx.db.select().from(challenges);
  const ids = all.map((c) => c.id);
  const parts = ids.length
    ? await ctx.db
        .select({
          id: challengeParticipants.challengeId,
          joined: sql<number>`count(*) filter (where ${challengeParticipants.state} = 'joined')::int`,
          invited: sql<number>`count(*) filter (where ${challengeParticipants.state} = 'invited')::int`,
        })
        .from(challengeParticipants)
        .where(inArray(challengeParticipants.challengeId, ids))
        .groupBy(challengeParticipants.challengeId)
    : [];
  const counts = new Map(parts.map((p) => [p.id, p]));
  const people = await getUsers(
    ctx,
    all.flatMap((c) => [c.createdBy, ...(c.leaderId ? [c.leaderId] : [])]),
  );
  const person = (id: string | null) => {
    const u = id ? people.get(id) : undefined;
    return u ? { id: u.id, displayName: u.displayName } : null;
  };

  const rows: AdminChallengeRow[] = all.map((c) => {
    const status = challengeStatus(ctx, c);
    return {
      id: c.id,
      name: c.name,
      metricLabel: challengeMetricDef(c).label,
      scoring: c.scoring,
      startDate: c.startDate,
      endDate: c.endDate,
      status,
      creator: person(c.createdBy),
      joined: counts.get(c.id)?.joined ?? 0,
      invited: counts.get(c.id)?.invited ?? 0,
      visibility: c.visibility,
      featured: c.featured,
      solo: !!c.solo,
      team: !!c.teamScoring,
      recurring: !!c.recurrence,
      leader: status === 'active' ? person(c.leaderId) : null,
    };
  });
  const kind = (r: AdminChallengeRow) =>
    r.status === 'active' ? 'running' : r.status === 'upcoming' ? 'upcoming' : 'finished';
  const q = opts.q?.toLowerCase();
  const searched = q
    ? rows.filter((r) =>
        [r.name, r.creator?.displayName ?? ''].some((s) => s.toLowerCase().includes(q)),
      )
    : rows;
  const order = { running: 0, upcoming: 1, finished: 2 };
  const shown = searched
    .filter((r) => opts.status === 'all' || kind(r) === opts.status)
    .sort(
      (a, b) =>
        order[kind(a)] - order[kind(b)] ||
        (kind(a) === 'finished'
          ? b.endDate.localeCompare(a.endDate)
          : a.endDate.localeCompare(b.endDate)),
    );
  return {
    challenges: shown,
    counts: {
      running: searched.filter((r) => kind(r) === 'running').length,
      upcoming: searched.filter((r) => kind(r) === 'upcoming').length,
      finished: searched.filter((r) => kind(r) === 'finished').length,
      all: searched.length,
    },
  };
}
