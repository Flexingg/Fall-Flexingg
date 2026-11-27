/**
 * Admin → Accounts: list and inspect accounts, schedule/cancel/perform deletions, clean up expired
 * accounts, and the sweep that carries out deletions that came due. Nothing here ever returns a
 * secret (SparkyFitness keys, token hashes, push endpoints/keys): rows are built field by field.
 *
 * Deletion is deliberately slow and reversible until the end: an admin schedules it (30 days), the
 * person is told in-app, and the sweep only deletes accounts whose person has not used the app
 * since it was scheduled (their own use, see activity.ts; background syncs don't count).
 */
import {
  accountTags,
  ACCOUNT_FILTERS,
  DELETION_GRACE_DAYS,
  expiredReason,
  initials,
  levelFor,
  scheduledOn,
  type AccountFilter,
  type AccountSort,
  type AdminAuditEntry,
  type AdminUserDetail,
  type AdminUserRow,
  type AdminUsersResponse,
  type CleanupResult,
} from '@gauntlet/shared';
import { sourceLabel } from '@gauntlet/sparky';
import { and, eq, gte, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { badRequest, forbidden } from '../context.js';
import {
  challengeParticipants,
  challenges,
  friendships,
  notifications,
  pushTargets,
  serverState,
  userBadges,
  users,
} from '../db/schema.js';
import { challengeStatus } from './challenges.js';
import { deleteAccount } from './deleteAccount.js';
import { notify } from './notify.js';
import { getUser, isAdmin, type UserRow } from './users.js';

const AUDIT_KEY = 'admin_audit';
const AUDIT_KEEP = 200;

// ---------- Audit trail ----------

export async function readAudit(ctx: AppContext): Promise<AdminAuditEntry[]> {
  const [row] = await ctx.db.select().from(serverState).where(eq(serverState.key, AUDIT_KEY));
  return Array.isArray(row?.value) ? (row.value as AdminAuditEntry[]) : [];
}

/** Newest first, last 200. Also a log line, so it survives in the logs even if this list is wiped. */
export async function recordAudit(
  ctx: AppContext,
  entry: Omit<AdminAuditEntry, 'at'>,
): Promise<void> {
  const full: AdminAuditEntry = { at: ctx.now().toISOString(), ...entry };
  ctx.log.info({ audit: full }, `admin audit: ${entry.action}`);
  await ctx.db.transaction(async (tx) => {
    // Serialise writers so two quick actions don't lose one.
    await tx.execute(sql`select pg_advisory_xact_lock(7340113)`);
    const [row] = await tx.select().from(serverState).where(eq(serverState.key, AUDIT_KEY));
    const prev = Array.isArray(row?.value) ? (row.value as AdminAuditEntry[]) : [];
    const value = [full, ...prev].slice(0, AUDIT_KEEP);
    await tx
      .insert(serverState)
      .values({ key: AUDIT_KEY, value, updatedAt: ctx.now() })
      .onConflictDoUpdate({ target: serverState.key, set: { value, updatedAt: ctx.now() } });
  });
}

// ---------- Rows ----------

interface Counts {
  challenges: { active: number; finished: number; won: number };
  friends: number;
}

async function countsFor(ctx: AppContext, ids?: string[]): Promise<Map<string, Counts>> {
  const out = new Map<string, Counts>();
  const get = (id: string) => {
    let c = out.get(id);
    if (!c) out.set(id, (c = { challenges: { active: 0, finished: 0, won: 0 }, friends: 0 }));
    return c;
  };
  const parts = await ctx.db
    .select({
      userId: challengeParticipants.userId,
      active: sql<number>`count(*) filter (where ${challenges.finalizedAt} is null)::int`,
      finished: sql<number>`count(*) filter (where ${challenges.finalizedAt} is not null)::int`,
      won: sql<number>`count(*) filter (where ${challenges.finalizedAt} is not null and ${challengeParticipants.finalRank} = 1)::int`,
    })
    .from(challengeParticipants)
    .innerJoin(challenges, eq(challenges.id, challengeParticipants.challengeId))
    .where(
      and(
        eq(challengeParticipants.state, 'joined'),
        ids ? inArray(challengeParticipants.userId, ids) : undefined,
      ),
    )
    .groupBy(challengeParticipants.userId);
  for (const p of parts)
    get(p.userId).challenges = { active: p.active, finished: p.finished, won: p.won };
  const fr = await ctx.db.execute<{ id: string; n: number }>(
    sql`select f.u as id, count(*)::int as n from (
          select user_low as u from friendships where status = 'accepted'
          union all
          select user_high as u from friendships where status = 'accepted'
        ) f group by f.u`,
  );
  for (const f of fr) get(f.id).friends = f.n;
  return out;
}

export function toAdminRow(
  ctx: AppContext,
  u: UserRow,
  c: Counts | undefined,
  now: Date,
): AdminUserRow {
  const admin = isAdmin(ctx, u);
  const facts = {
    isDemo: u.isDemo,
    isAdmin: admin,
    keyStatus: u.keyStatus,
    lastSyncedAt: u.lastSyncedAt,
    lastActiveAt: u.lastActiveAt,
    createdAt: u.createdAt,
    lastSyncError: u.lastSyncError,
    deletionScheduledAt: u.deletionScheduledAt,
  };
  return {
    id: u.id,
    displayName: u.displayName,
    initials: initials(u.displayName),
    handle: u.handle,
    email: u.email,
    createdAt: u.createdAt.toISOString(),
    lastActiveAt: u.lastActiveAt?.toISOString() ?? null,
    lastSyncedAt: u.lastSyncedAt?.toISOString() ?? null,
    keyStatus: u.keyStatus,
    healthConnectSync: u.healthConnectSync,
    isDemo: u.isDemo,
    isAdmin: admin,
    level: levelFor(u.badgeXp).level,
    challenges: c?.challenges ?? { active: 0, finished: 0, won: 0 },
    friends: c?.friends ?? 0,
    deletionScheduledAt: u.deletionScheduledAt?.toISOString() ?? null,
    deletionReason: u.deletionReason,
    activeSinceScheduled:
      !!u.deletionScheduledAt &&
      !!u.lastActiveAt &&
      u.lastActiveAt > scheduledOn(u.deletionScheduledAt),
    tags: accountTags(facts, now),
    expiredReason: expiredReason(facts, now),
  };
}

const matches = (filter: AccountFilter, r: AdminUserRow): boolean => {
  switch (filter) {
    case 'all':
      return true;
    case 'active':
      return r.tags.includes('active');
    case 'inactive':
      return r.tags.includes('inactive');
    case 'expired':
      return r.tags.includes('expired');
    case 'scheduled':
      return r.tags.includes('scheduled');
    case 'problems':
      return r.tags.includes('sync_problem') || r.tags.includes('key_lost');
  }
};

const SORTS: Record<AccountSort, (a: AdminUserRow, b: AdminUserRow) => number> = {
  recent: (a, b) => (b.lastActiveAt ?? b.createdAt).localeCompare(a.lastActiveAt ?? a.createdAt),
  quiet: (a, b) => (a.lastActiveAt ?? a.createdAt).localeCompare(b.lastActiveAt ?? b.createdAt),
  name: (a, b) => a.displayName.localeCompare(b.displayName),
  newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
};

/** Accounts are few, so everything is worked out in memory and then paged. */
export async function listAccounts(
  ctx: AppContext,
  opts: { q?: string; filter: AccountFilter; sort: AccountSort; limit: number; offset: number },
): Promise<AdminUsersResponse> {
  const now = ctx.now();
  const [all, counts] = await Promise.all([ctx.db.select().from(users), countsFor(ctx)]);
  const rows = all.map((u) => toAdminRow(ctx, u, counts.get(u.id), now));
  const q = opts.q?.toLowerCase();
  const searched = q
    ? rows.filter((r) =>
        [r.displayName, r.handle ?? '', r.email].some((s) => s.toLowerCase().includes(q)),
      )
    : rows;
  const filtered = searched.filter((r) => matches(opts.filter, r)).sort(SORTS[opts.sort]);
  return {
    users: filtered.slice(opts.offset, opts.offset + opts.limit),
    total: filtered.length,
    limit: opts.limit,
    offset: opts.offset,
    counts: Object.fromEntries(
      ACCOUNT_FILTERS.map((f) => [f, rows.filter((r) => matches(f, r)).length]),
    ) as Record<AccountFilter, number>,
  };
}

export async function accountDetail(ctx: AppContext, id: string): Promise<AdminUserDetail> {
  const u = await getUser(ctx, id);
  const now = ctx.now();
  const counts = await countsFor(ctx, [id]);
  const row = toAdminRow(ctx, u, counts.get(id), now);

  const parts = await ctx.db
    .select({ p: challengeParticipants, c: challenges })
    .from(challengeParticipants)
    .innerJoin(challenges, eq(challenges.id, challengeParticipants.challengeId))
    .where(eq(challengeParticipants.userId, id));
  const order = { active: 0, upcoming: 1, completed: 2 } as const;
  const challengeList = parts
    .map(({ p, c }) => ({
      id: c.id,
      name: c.name,
      status: challengeStatus(ctx, c),
      startDate: c.startDate,
      endDate: c.endDate,
      state: p.state,
      rank: c.finalizedAt ? p.finalRank : null,
      createdByThem: c.createdBy === id,
    }))
    .sort((a, b) => order[a.status] - order[b.status] || b.endDate.localeCompare(a.endDate));

  const friendRows = await ctx.db
    .select({ low: friendships.userLow, high: friendships.userHigh })
    .from(friendships)
    .where(
      and(
        eq(friendships.status, 'accepted'),
        or(eq(friendships.userLow, id), eq(friendships.userHigh, id)),
      ),
    );
  const friendIds = friendRows.map((f) => (f.low === id ? f.high : f.low));
  const friendNames = friendIds.length
    ? (
        await ctx.db
          .select({ name: users.displayName })
          .from(users)
          .where(inArray(users.id, friendIds))
      )
        .map((f) => f.name)
        .sort((a, b) => a.localeCompare(b))
    : [];

  const [targets] = await ctx.db
    .select({
      webpush: sql<number>`count(*) filter (where ${pushTargets.kind} = 'webpush')::int`,
      device: sql<number>`count(*) filter (where ${pushTargets.kind} = 'device')::int`,
    })
    .from(pushTargets)
    .where(eq(pushTargets.userId, id));
  const [recent] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, id),
        gte(notifications.createdAt, new Date(now.getTime() - 30 * 86_400_000)),
      ),
    );
  const [earned] = await ctx.db
    .select({ n: sql<number>`count(distinct ${userBadges.badgeKey})::int` })
    .from(userBadges)
    .where(eq(userBadges.userId, id));

  const sources = [...new Set(Object.values(u.seenSources).flat())].map(sourceLabel).sort();
  return {
    ...row,
    timezone: u.timezone,
    visibility: u.visibility,
    sharing: {
      workoutDetails: u.shareWorkoutDetails,
      events: u.shareEvents,
      profileStats: u.shareProfileStats,
    },
    dataSources: { metrics: Object.keys(u.seenSources).length, sources },
    lastSyncError: u.lastSyncError,
    lastSyncErrorAt: u.lastSyncErrorAt?.toISOString() ?? null,
    notificationPrefsSet: Object.keys(u.notificationPrefs).length,
    pushTargets: { webpush: targets?.webpush ?? 0, device: targets?.device ?? 0 },
    recentNotifications: recent?.n ?? 0,
    badges: { earned: earned?.n ?? 0, xp: u.badgeXp },
    challengeList,
    friendNames,
  };
}

// ---------- Deletion ----------

const longDate = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: tz }).format(d);

function checkTarget(ctx: AppContext, adminId: string, target: UserRow): void {
  if (target.id === adminId) throw forbidden('You cannot do that to your own account');
  if (target.isDemo) throw forbidden('The demo account cannot be deleted');
  if (isAdmin(ctx, target)) throw forbidden('Admin accounts cannot be deleted from here');
}

async function schedule(
  ctx: AppContext,
  target: UserRow,
  reason: string | null,
): Promise<{ at: Date }> {
  const at = new Date(ctx.now().getTime() + DELETION_GRACE_DAYS * 86_400_000);
  await ctx.db
    .update(users)
    .set({ deletionScheduledAt: at, deletionReason: reason })
    .where(eq(users.id, target.id));
  // The person must hear about it whatever their notification settings (kind "account" is always on).
  await notify(ctx, target.id, {
    kind: 'account',
    title: 'Your account is scheduled for deletion',
    body: `Your Gauntlet account will be deleted on ${longDate(at, target.timezone)} because it hasn't been used. Open the app to keep it.`,
    url: '/',
    payload: { deletionAt: at.toISOString() },
  }).catch((err) => ctx.log.warn({ err: String(err) }, 'deletion notice failed'));
  return { at };
}

export async function scheduleDeletion(
  ctx: AppContext,
  adminId: string,
  targetId: string,
  reason: string | undefined,
): Promise<AdminUserRow> {
  const target = await getUser(ctx, targetId);
  checkTarget(ctx, adminId, target);
  const why = reason?.trim() || null;
  await schedule(ctx, target, why);
  await recordAudit(ctx, {
    adminId,
    adminName: (await getUser(ctx, adminId)).displayName,
    action: 'schedule_deletion',
    targetId,
    targetName: target.displayName,
    detail: why,
  });
  return (await accountDetail(ctx, targetId)) as AdminUserRow;
}

export async function cancelDeletion(
  ctx: AppContext,
  adminId: string,
  targetId: string,
): Promise<AdminUserRow> {
  const target = await getUser(ctx, targetId);
  if (!target.deletionScheduledAt) throw badRequest('No deletion is scheduled for that account');
  await ctx.db
    .update(users)
    .set({ deletionScheduledAt: null, deletionReason: null })
    .where(eq(users.id, targetId));
  await recordAudit(ctx, {
    adminId,
    adminName: (await getUser(ctx, adminId)).displayName,
    action: 'cancel_deletion',
    targetId,
    targetName: target.displayName,
    detail: null,
  });
  return (await accountDetail(ctx, targetId)) as AdminUserRow;
}

export async function deleteNow(
  ctx: AppContext,
  adminId: string,
  targetId: string,
  confirm: string,
): Promise<{ ok: true; transferred: number }> {
  const target = await getUser(ctx, targetId);
  checkTarget(ctx, adminId, target);
  if (confirm.trim() !== target.displayName)
    throw badRequest(`Type their name (${target.displayName}) to confirm`, 'confirm_required');
  const { transferred } = await deleteAccount(ctx, targetId);
  logDeletion(ctx, target, 'admin', null);
  await recordAudit(ctx, {
    adminId,
    adminName: (await getUser(ctx, adminId)).displayName,
    action: 'delete_account',
    targetId,
    targetName: target.displayName,
    detail: transferred ? `${transferred} challenge(s) handed to another member` : null,
  });
  return { ok: true, transferred };
}

/** One searchable line per deleted account, so the logs say who was removed even after a restore. */
function logDeletion(
  ctx: AppContext,
  u: UserRow,
  how: 'admin' | 'scheduled',
  reason: string | null,
) {
  ctx.log.info(
    {
      event: 'account_deleted',
      how,
      userId: u.id,
      displayName: u.displayName,
      email: u.email,
      createdAt: u.createdAt.toISOString(),
      lastActiveAt: u.lastActiveAt?.toISOString() ?? null,
      reason: reason ?? u.deletionReason,
    },
    `account deleted (${how}): ${u.displayName} <${u.email}>`,
  );
}

/** Schedule deletion (30 days, "Expired") for every expired account not already scheduled. */
export async function cleanupExpired(
  ctx: AppContext,
  adminId: string,
  dryRun: boolean,
): Promise<CleanupResult> {
  const now = ctx.now();
  const all = await ctx.db.select().from(users).where(eq(users.isDemo, false));
  const hit = all
    .filter((u) => !u.deletionScheduledAt)
    .map((u) => ({ u, why: expiredReason(toAdminRow(ctx, u, undefined, now), now) }))
    .filter((x): x is { u: UserRow; why: string } => !!x.why);
  if (!dryRun) {
    for (const { u } of hit) await schedule(ctx, u, 'Expired');
    await recordAudit(ctx, {
      adminId,
      adminName: (await getUser(ctx, adminId)).displayName,
      action: 'cleanup_expired',
      targetId: null,
      targetName: null,
      detail: `${hit.length} account(s) scheduled`,
    });
  }
  return {
    dryRun,
    accounts: hit.map(({ u, why }) => ({ id: u.id, displayName: u.displayName, reason: why })),
  };
}

/**
 * Carry out deletions that came due. Someone who used the app since it was scheduled is kept (and
 * the schedule cleared); everyone else is deleted. Cheap: one indexed-ish query a cycle.
 */
export async function sweepScheduledDeletions(
  ctx: AppContext,
): Promise<{ deleted: number; kept: number }> {
  const due = await ctx.db
    .select()
    .from(users)
    .where(
      and(
        isNotNull(users.deletionScheduledAt),
        lte(users.deletionScheduledAt, ctx.now()),
        eq(users.isDemo, false),
      ),
    );
  let deleted = 0;
  let kept = 0;
  for (const u of due) {
    try {
      const active = !!u.lastActiveAt && u.lastActiveAt > scheduledOn(u.deletionScheduledAt!);
      if (isAdmin(ctx, u) || active) {
        await ctx.db
          .update(users)
          .set({ deletionScheduledAt: null, deletionReason: null })
          .where(eq(users.id, u.id));
        await recordAudit(ctx, {
          adminId: null,
          adminName: 'Automatic',
          action: 'auto_keep',
          targetId: u.id,
          targetName: u.displayName,
          detail: 'Used the app since the deletion was scheduled',
        });
        kept++;
        continue;
      }
      await deleteAccount(ctx, u.id);
      logDeletion(ctx, u, 'scheduled', null);
      await recordAudit(ctx, {
        adminId: null,
        adminName: 'Automatic',
        action: 'auto_delete',
        targetId: u.id,
        targetName: u.displayName,
        detail: u.deletionReason,
      });
      deleted++;
    } catch (err) {
      ctx.log.warn({ err: String(err), userId: u.id }, 'scheduled deletion failed');
    }
  }
  return { deleted, kept };
}
