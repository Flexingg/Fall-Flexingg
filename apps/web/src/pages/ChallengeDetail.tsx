import { needsWeightGoal, scoringLabel, type WeightGoalParams } from '@gauntlet/shared';
import { EditChallenge } from '../components/EditChallenge';
import { WeightGoalFields } from '../components/WeightGoal';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Icon } from '../components/Icon';
import { Podium, StandingsList } from '../components/Standings';
import {
  ErrorBox,
  Header,
  NoSourcesNote,
  Screen,
  ShowEventsNotice,
  Skeleton,
  toast,
} from '../components/ui';
import { del, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateRange, daysLeftText, fmt } from '../lib/format';
import { keys, useChallenge, useToday } from '../lib/queries';
import { shareLink } from '../lib/share';
import type { Invite } from '@gauntlet/shared';

export function ChallengeDetailPage() {
  const { id = '' } = useParams();
  const q = useChallenge(id);
  const today = useToday();
  const { user } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [weightGoal, setWeightGoal] = useState<WeightGoalParams | null>(null);
  const [error, setError] = useState<unknown>(null);
  const c = q.data;
  const needsTarget = !!c && needsWeightGoal(c.metric) && !c.myParams?.weightGoal;
  const params = needsTarget && weightGoal ? { weightGoal } : undefined;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function invite() {
    const inv = await post<Invite>('/api/invites', { kind: 'challenge', challengeId: id });
    const r = await shareLink(
      `Join ${c!.name} on Gauntlet`,
      `${user?.displayName} challenged you: ${c!.name}`,
      inv.url,
    );
    if (r === 'copied') toast('Invite link copied');
  }

  return (
    <Screen>
      <Header
        title={c?.name ?? ' '}
        back="/challenges"
        action={
          c && c.createdBy === user?.id && c.status !== 'completed' ? (
            <button
              className="btn sm secondary"
              style={{ width: 'auto' }}
              onClick={() => setEditing((e) => !e)}
              aria-expanded={editing}
            >
              Edit
            </button>
          ) : undefined
        }
      />
      <ErrorBox error={q.error ?? error} />
      {q.isPending && <Skeleton height={320} />}
      {c && (
        <>
          <p className="muted" style={{ marginTop: -8, marginBottom: 14, fontSize: 14 }}>
            {c.metricLabel} · {scoringLabel(c.scoring, c.aggregate)}
            {c.goal ? ` · ${fmt(c.goal, c)}${c.scoring === 'streak' ? '/day' : ''}` : ''} ·{' '}
            {dateRange(c.startDate, c.endDate)} · {daysLeftText(c)}
            {c.visibility === 'public' ? ' · Public' : ''}
            {c.featured ? ' · Featured' : ''}
          </p>

          {(c.myState == null || c.myState === 'declined') &&
            c.visibility === 'public' &&
            c.status !== 'completed' && (
              <div className="card stack" style={{ marginBottom: 14 }}>
                <b>Open to everyone</b>
                {c.showEvents && <ShowEventsNotice />}
                {today.data && !today.data.hasSources && <NoSourcesNote />}
                {user?.visibility === 'public' ? (
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => act(() => post(`/api/challenges/${id}/join`))}
                  >
                    Join challenge
                  </button>
                ) : (
                  <p className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
                    Your profile is private. <Link to="/me">Make it public</Link> to join, so others
                    can see your name on the leaderboard.
                  </p>
                )}
              </div>
            )}

          {editing && <EditChallenge c={c} onDone={() => setEditing(false)} />}

          {c.myState === 'invited' && (
            <div className="card stack" style={{ marginBottom: 14 }}>
              <b>You're invited</b>
              {c.showEvents && <ShowEventsNotice />}
              {needsTarget && <WeightGoalFields value={weightGoal} onChange={setWeightGoal} />}
              <div className="row">
                <button
                  className="btn"
                  disabled={busy || (needsTarget && !weightGoal)}
                  onClick={() =>
                    act(() => post(`/api/challenges/${id}/respond`, { accept: true, params }))
                  }
                >
                  Accept
                </button>
                <button
                  className="btn secondary"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await post(`/api/challenges/${id}/respond`, { accept: false });
                      navigate('/challenges');
                    })
                  }
                >
                  Decline
                </button>
              </div>
            </div>
          )}

          {c.status === 'completed' && (
            <Link to={`/c/${id}/result`} className="hero" style={{ marginBottom: 14 }}>
              <div className="badge">
                <Icon name="trophy" />
              </div>
              <div className="grow">
                <small>Challenge over</small>
                <b>See the results</b>
              </div>
            </Link>
          )}

          {c.myParams?.weightGoal && (
            <p className="muted" style={{ fontSize: 13, marginTop: -6, marginBottom: 12 }}>
              Your target: {c.myParams.weightGoal.direction} {c.myParams.weightGoal.target}
              {c.myParams.weightGoal.targetType === 'percent' ? '%' : ' kg'}. Only your % is shown.
            </p>
          )}
          <Podium challenge={c} />
          {c.standings.length > 0 ? (
            <StandingsList challenge={c} showToday={c.status === 'active'} />
          ) : (
            <div className="notice">Nobody has joined yet.</div>
          )}

          {c.invited.length > 0 && (
            <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
              Waiting on {c.invited.map((u) => u.displayName.split(' ')[0]).join(', ')}
            </p>
          )}

          {c.status !== 'completed' && c.myState === 'joined' && (
            <div className="stack" style={{ marginTop: 20 }}>
              <button className="btn" onClick={() => invite().catch(setError)}>
                <Icon name="share" size={18} /> Invite friends
              </button>
              {c.createdBy === user?.id && c.status === 'upcoming' ? (
                <button
                  className="btn ghost"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await del(`/api/challenges/${id}`);
                      navigate('/challenges');
                    })
                  }
                >
                  Delete challenge
                </button>
              ) : (
                <button
                  className="btn ghost"
                  disabled={busy}
                  onClick={() =>
                    confirm('Leave this challenge?') &&
                    act(async () => {
                      await post(`/api/challenges/${id}/leave`);
                      qc.removeQueries({ queryKey: keys.challenge(id) });
                      navigate('/challenges');
                    })
                  }
                >
                  Leave challenge
                </button>
              )}
            </div>
          )}
          {user?.isAdmin && c.visibility === 'public' && c.status !== 'completed' && (
            <button
              className="btn ghost"
              style={{ marginTop: 8 }}
              disabled={busy}
              onClick={() =>
                act(() => patch(`/api/challenges/${id}/featured`, { featured: !c.featured }))
              }
            >
              {c.featured ? 'Unfeature' : 'Feature in Discover'}
            </button>
          )}
        </>
      )}
    </Screen>
  );
}
