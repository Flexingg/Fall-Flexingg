import type { AllTimeStats, MeUser, Milestone, ProfileResponse, Trophy } from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Icon } from '../components/Icon';
import { NudgeButton } from '../components/NudgeButton';
import { Avatar, Empty, ErrorBox, Header, Screen, toast, Toggle } from '../components/ui';
import { SkeletonCard, SkeletonGroup, SkeletonLine, SkeletonList } from '../components/Skeleton';
import { ApiError, del, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { keys, useProfile } from '../lib/queries';
import { deferAction, usePendingUndo } from '../lib/undo';
import {
  fmtDate,
  fmtDistanceKm,
  fmtFlex,
  fmtInt,
  fmtLiftTotalKg,
  fmtWeightKg,
} from '../lib/format';
import { HeadToHead } from '../components/HeadToHead';
import { CalendarHeatmap } from '../components/CalendarHeatmap';

/** Someone's profile (or your own): record, trophy board, milestones and all-time stats. */
export function ProfilePage() {
  const { id = '' } = useParams();
  const q = useProfile(id);
  const p = q.data;

  return (
    <Screen>
      <Header title={p ? (p.user.friendship === 'me' ? 'Your profile' : 'Profile') : ''} back />
      {q.error instanceof ApiError && q.error.status === 404 ? (
        <div className="list">
          <Empty title="Profile not available">
            This person's profile is private. Friends and people in the same challenges can see it.
          </Empty>
        </div>
      ) : (
        <ErrorBox error={q.error} />
      )}
      {q.isPending && (
        <SkeletonGroup>
          <SkeletonCard>
            <div className="row" style={{ gap: 14 }}>
              <SkeletonLine width={64} height={64} style={{ borderRadius: '50%' }} />
              <div className="grow stack" style={{ gap: 10 }}>
                <SkeletonLine width="50%" height={16} />
                <SkeletonLine width="70%" />
              </div>
            </div>
          </SkeletonCard>
          <SkeletonCard lines={3} />
          <SkeletonList rows={3} />
        </SkeletonGroup>
      )}
      {p && (
        <div className="stack" style={{ gap: 14 }}>
          <Identity p={p} />
          <Record p={p} />
          <TrophyBoard p={p} />
          {p.user.friendship !== 'me' && <HeadToHead userId={p.user.id} />}
          {/* Same rule as the all-time stats: yours always, others only if they share. */}
          {p.stats && (
            <CalendarHeatmap
              userId={p.user.id}
              name={p.user.friendship === 'me' ? undefined : p.user.displayName.split(' ')[0]}
            />
          )}
          <Stats p={p} />
        </div>
      )}
    </Screen>
  );
}

const monthYear = (d: string) => fmtDate(d, { month: 'short', year: 'numeric' });
const shortDate = (d: string) => fmtDate(d, { month: 'short', day: 'numeric', year: 'numeric' });
const n = (v: number) => fmtInt(v);
const one = (v: number) => fmtFlex(v, 1);

function Identity({ p }: { p: ProfileResponse }) {
  const u = p.user;
  return (
    <div className="card profile-head">
      <Avatar user={u} size={64} me={u.friendship === 'me'} />
      <div className="grow" style={{ minWidth: 0 }}>
        <h2 className="profile-name">{u.displayName}</h2>
        <small className="muted">
          {u.handle ? `@${u.handle} · ` : ''}Member since {monthYear(u.memberSince)}
        </small>
        <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          {u.friendship === 'friends' && <span className="pill">Friends</span>}
          {u.friendship !== 'me' && (
            <NudgeButton userId={u.id} name={u.displayName.split(' ')[0]} />
          )}
          {u.friendship === 'me' && (
            <span className="pill plain">
              {u.visibility === 'public' ? 'Public profile' : 'Private profile'}
            </span>
          )}
        </div>
      </div>
      <FriendActions p={p} />
    </div>
  );
}

function FriendActions({ p }: { p: ProfileResponse }) {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const [busy, setBusy] = useState(false);
  const u = p.user;
  const waiting = usePendingUndo();
  // The demo account's crew is fixed (the server refuses friend changes from it).
  if (me?.demo && u.friendship !== 'me') return null;

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      toast(done);
      await qc.invalidateQueries();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  // Unfriended a moment ago and still undoable: show it as done.
  const friendship = waiting.has(`unfriend:${u.id}`) ? 'none' : u.friendship;
  switch (friendship) {
    case 'me':
      return (
        <Link to="/me" className="btn sm secondary">
          Edit
        </Link>
      );
    case 'none':
      return (
        <button
          className="btn sm"
          disabled={busy}
          onClick={() => run(() => post('/api/friends/requests', { userId: u.id }), 'Request sent')}
        >
          Add friend
        </button>
      );
    case 'outgoing':
      return (
        <button
          className="btn sm secondary"
          disabled={busy}
          onClick={() => run(() => del(`/api/friends/${u.id}`), 'Request cancelled')}
        >
          Cancel request
        </button>
      );
    case 'incoming':
      return (
        <div className="stack" style={{ gap: 6 }}>
          <button
            className="btn sm"
            disabled={busy}
            onClick={() =>
              run(() => post(`/api/friends/requests/${u.id}/accept`), "You're now friends")
            }
          >
            Accept
          </button>
          <button
            className="btn sm secondary"
            disabled={busy}
            onClick={() => run(() => del(`/api/friends/${u.id}`), 'Request declined')}
          >
            Decline
          </button>
        </div>
      );
    case 'friends':
      return (
        <button
          className="btn sm danger"
          disabled={busy}
          onClick={() =>
            deferAction({
              key: `unfriend:${u.id}`,
              message: `Unfriended ${u.displayName}`,
              commit: () => del(`/api/friends/${u.id}`),
              settle: (err) => {
                if (err) toast(err instanceof Error ? err.message : 'Something went wrong');
                void qc.invalidateQueries();
              },
            })
          }
        >
          Unfriend
        </button>
      );
  }
}

function Record({ p }: { p: ProfileResponse }) {
  const { played, won } = p.user.challenges;
  const podiums = p.trophies.gold + p.trophies.silver + p.trophies.bronze;
  return (
    <div className="pb pb3">
      <div>
        <b className="num">{played}</b>
        <span>Challenges</span>
      </div>
      <div>
        <b className="num">{won}</b>
        <span>Won</span>
      </div>
      <div>
        <b className="num">{podiums}</b>
        <span>Podiums</span>
      </div>
    </div>
  );
}

const MEDAL = { 1: 'gold', 2: 'silver', 3: 'bronze' } as const;

function TrophyBoard({ p }: { p: ProfileResponse }) {
  const [all, setAll] = useState(false);
  const t = p.trophies;
  const shown = all ? t.list : t.list.slice(0, 5);
  return (
    <section>
      <div className="lbl">Trophy board</div>
      <div className="card stack" style={{ gap: 14 }}>
        <div className="medals">
          {([1, 2, 3] as const).map((rank) => (
            <div key={rank} className={`medal ${MEDAL[rank]}`}>
              <Icon name="trophy" size={22} />
              <b className="num">{[t.gold, t.silver, t.bronze][rank - 1]}</b>
              <span>{['1st', '2nd', '3rd'][rank - 1]}</span>
            </div>
          ))}
        </div>
        {t.list.length === 0 ? (
          <small className="muted">
            No podium finishes yet. Finish in the top 3 of a challenge with friends to earn one.
          </small>
        ) : (
          <div className="list">
            {shown.map((tr, i) => (
              <TrophyRow key={`${tr.challengeId ?? 'private'}-${i}`} t={tr} />
            ))}
            {t.list.length > 5 && (
              <button className="item" onClick={() => setAll((a) => !a)}>
                <div className="grow t muted">
                  {all ? 'Show fewer' : `Show all ${t.list.length}`}
                </div>
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function TrophyRow({ t }: { t: Trophy }) {
  const body = (
    <>
      <span className={`medal-dot ${MEDAL[t.rank as 1 | 2 | 3]}`} aria-label={`Place ${t.rank}`}>
        {t.rank}
      </span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="t ellipsis">{t.name}</div>
        <small className="ellipsis">
          {[t.metricLabel, `of ${t.field}`, shortDate(t.endDate)].filter(Boolean).join(' · ')}
        </small>
      </div>
      {t.challengeId && <Icon name="chevron" size={16} />}
    </>
  );
  return t.challengeId ? (
    <Link to={`/c/${t.challengeId}/result`} className="item">
      {body}
    </Link>
  ) : (
    <div className="item">{body}</div>
  );
}

function Stats({ p }: { p: ProfileResponse }) {
  const isMe = p.user.friendship === 'me';
  if (!p.stats) {
    return (
      <section>
        <div className="lbl">All-time stats</div>
        <div className="card">
          <small className="muted">
            {p.user.displayName.split(' ')[0]} keeps their stats and milestones to themselves.
          </small>
        </div>
      </section>
    );
  }
  return (
    <>
      {p.milestones && <Milestones list={p.milestones} isMe={isMe} />}
      <AllTime s={p.stats} />
      {isMe && <ShareToggle shared={p.shared} />}
    </>
  );
}

function Milestones({ list, isMe }: { list: Milestone[]; isMe: boolean }) {
  // Others only see what's been reached; you also see what's next.
  const shown = isMe ? list : list.filter((m) => m.achieved);
  if (!shown.length) return null;
  return (
    <section>
      <div className="lbl">Milestones</div>
      <div className="milestones">
        {shown.map((m) => (
          <div
            key={m.key}
            className={`milestone${m.achieved ? ' done' : ''}`}
            aria-label={`${m.label}${m.achieved ? ', reached' : `, ${Math.round(m.progress * 100)}% there`}`}
          >
            <Icon name={FAMILY_ICON[m.family]} size={18} />
            <b>{m.label}</b>
            {!m.achieved && (
              <div className="milestone-bar" aria-hidden>
                <i style={{ width: `${Math.round(m.progress * 100)}%` }} />
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

const FAMILY_ICON: Record<Milestone['family'], Parameters<typeof Icon>[0]['name']> = {
  steps: 'steps',
  distance: 'distance',
  workouts: 'flame',
  lifting: 'dumbbell',
  streak: 'target',
  wins: 'trophy',
};

function AllTime({ s }: { s: AllTimeStats }) {
  const t = s.totals;
  const b = s.bests;
  const tiles = [
    { label: 'Steps', value: t.steps, fmt: n },
    { label: 'Distance', value: t.distanceKm, fmt: (v: number) => fmtDistanceKm(v) },
    { label: 'Workouts', value: t.workouts, fmt: n },
    { label: 'Active minutes', value: t.activeMinutes, fmt: n },
    { label: 'Active kcal', value: t.activeCalories, fmt: n },
    {
      label: 'Volume lifted',
      value: t.liftVolumeKg,
      fmt: fmtLiftTotalKg,
    },
    { label: 'Sets logged', value: t.liftSets, fmt: n },
    { label: 'Hours fasted', value: t.fastHours, fmt: (v: number) => `${one(v)} h` },
  ].filter((x) => x.value > 0);
  const bests = [
    { label: 'Best step day', value: b.steps, fmt: n },
    { label: 'Best distance day', value: b.distanceKm, fmt: (v: number) => fmtDistanceKm(v) },
    { label: 'Longest 10k streak', value: b.stepStreakDays || null, fmt: (v: number) => `${v} d` },
    { label: 'Biggest lift day', value: b.liftVolumeKg, fmt: (v: number) => fmtWeightKg(v, 0) },
    { label: 'Longest fast', value: b.longestFastHours, fmt: (v: number) => `${one(v)} h` },
  ].filter(
    (x): x is { label: string; value: number; fmt: (v: number) => string } => x.value != null,
  );

  return (
    <section>
      <div className="lbl">All-time stats</div>
      {tiles.length === 0 && bests.length === 0 ? (
        <div className="card">
          <small className="muted">No activity synced yet.</small>
        </div>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          <div className="pb">
            {[...tiles, ...bests].map((x) => (
              <div key={x.label}>
                <b className="num">{x.fmt(x.value)}</b>
                <span>{x.label}</span>
              </div>
            ))}
          </div>
          {s.since && (
            <small className="muted">
              Since {shortDate(s.since)} · {n(s.daysTracked)} days tracked
            </small>
          )}
        </div>
      )}
    </section>
  );
}

function ShareToggle({ shared }: { shared: boolean }) {
  const { setUser } = useAuth();
  const qc = useQueryClient();
  async function set(on: boolean) {
    try {
      setUser(await patch<MeUser>('/api/me', { settings: { shareProfileStats: on } }));
      await qc.invalidateQueries({ queryKey: keys.profiles });
      toast(on ? 'Stats shared' : 'Stats hidden');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Something went wrong');
    }
  }
  return (
    <div className="card row">
      <div className="grow">
        <div style={{ fontWeight: 700 }}>Share stats and milestones</div>
        <small className="muted">
          {shared
            ? 'People who can see your profile see these too.'
            : 'Only you can see these. Your trophies are always on your profile.'}
        </small>
      </div>
      <Toggle checked={shared} onChange={set} label="Share stats and milestones" />
    </div>
  );
}
