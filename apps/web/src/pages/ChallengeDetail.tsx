import {
  needsWeightGoal,
  scoringLabel,
  toDisplayUnit,
  type WeightGoalParams,
} from '@gauntlet/shared';
import { ArrangeTeams, SeriesCard, TeamLeaderboard, TeamPicker } from '../components/TeamsView';
import { ChallengeEvents } from '../components/ChallengeEvents';
import { SoloCard } from '../components/SoloCard';
import { EditChallenge } from '../components/EditChallenge';
import { WeightGoalFields } from '../components/WeightGoal';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Icon } from '../components/Icon';
import { Podium, StandingsList } from '../components/Standings';
import { ErrorBox, Header, NoSourcesNote, Screen, ShowEventsNotice, toast } from '../components/ui';
import { SkeletonCard, SkeletonChart, SkeletonGroup, SkeletonList } from '../components/Skeleton';
import { del, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { getDisplay } from '../lib/display';
import { dateRange, daysLeftText, fmt, fmtFlex, fmtQtyFlex, fmtSolo } from '../lib/format';
import { keys, useChallenge, useProgress, useToday } from '../lib/queries';
import { ProgressChart } from '../components/ProgressChart';
import { shareLink } from '../lib/share';
import type { Invite } from '@gauntlet/shared';

export function ChallengeDetailPage() {
  const { id = '' } = useParams();
  const q = useChallenge(id);
  const progress = useProgress(id);
  const today = useToday();
  const { user } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [weightGoal, setWeightGoal] = useState<WeightGoalParams | null>(null);
  const [pickedTeam, setPickedTeam] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const c = q.data;
  const solo = !!c?.soloConfig;
  const needsTarget = !!c && needsWeightGoal(c.metric) && !c.myParams?.weightGoal;
  const params = needsTarget && weightGoal ? { weightGoal } : undefined;
  // Team challenges: you pick a team to join; an invite may already suggest one.
  const teamChoice = pickedTeam ?? c?.myTeamId ?? null;
  const teamBody = c?.teams ? { teamId: teamChoice ?? undefined } : {};
  const needsTeam = !!c?.teams && !teamChoice;
  const canSwitchTeam = c?.teams && c.myState === 'joined' && c.status === 'upcoming';

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
      {q.isPending && (
        <SkeletonGroup>
          <SkeletonCard lines={2} />
          <SkeletonChart height={150} bars={10} />
          <SkeletonList rows={4} />
        </SkeletonGroup>
      )}
      {c && (
        <>
          <p className="muted" style={{ marginTop: -8, marginBottom: 14, fontSize: 14 }}>
            {c.metricLabel} · {solo ? 'Solo' : scoringLabel(c.scoring, c.aggregate)}
            {c.goal ? ` · ${fmt(c.goal, c)}${c.scoring === 'streak' ? '/day' : ''}` : ''} ·{' '}
            {dateRange(c.startDate, c.endDate)} · {daysLeftText(c)}
            {c.series ? ` · Round ${c.series.round}` : ''}
            {c.recurrence
              ? c.recurrence.every === 'week'
                ? ' · Repeats weekly'
                : ' · Repeats monthly'
              : ''}
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
                {c.teams && (
                  <TeamPicker teams={c.teams} value={teamChoice} onChange={setPickedTeam} />
                )}
                {user?.visibility === 'public' ? (
                  <button
                    className="btn"
                    disabled={busy || needsTeam}
                    onClick={() => act(() => post(`/api/challenges/${id}/join`, teamBody))}
                  >
                    {needsTeam ? 'Pick a team to join' : 'Join challenge'}
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
              {c.teams && (
                <TeamPicker teams={c.teams} value={teamChoice} onChange={setPickedTeam} />
              )}
              {needsTarget && <WeightGoalFields value={weightGoal} onChange={setWeightGoal} />}
              <div className="row">
                <button
                  className="btn"
                  disabled={busy || (needsTarget && !weightGoal) || needsTeam}
                  onClick={() =>
                    act(() =>
                      post(`/api/challenges/${id}/respond`, { accept: true, params, ...teamBody }),
                    )
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
              Your target: {c.myParams.weightGoal.direction}{' '}
              {c.myParams.weightGoal.targetType === 'percent'
                ? `${fmtFlex(c.myParams.weightGoal.target, 1)}%`
                : fmtQtyFlex(c.myParams.weightGoal.target, 'kg', 1)}
              . Only your % is shown.
            </p>
          )}
          {solo ? (
            <SoloCard c={c} />
          ) : (
            <>
              <TeamLeaderboard c={c} showScores />
              {!c.teams && <Podium challenge={c} />}
              {c.teams && c.standings.length > 0 && (
                <div className="lbl">
                  <span>People</span>
                </div>
              )}
              {c.standings.length > 0 ? (
                <StandingsList challenge={c} showToday={c.status === 'active'} />
              ) : (
                <div className="notice">Nobody has joined yet.</div>
              )}
            </>
          )}

          {progress.data && progress.data.dates.length > 0 && (
            <>
              <div className="lbl">Progress</div>
              <div className="card">
                <ProgressChart
                  data={progress.data}
                  format={(v) => fmtSolo(v, progress.data!.valueKind, c)}
                  scale={
                    progress.data.valueKind === 'metric'
                      ? toDisplayUnit(1, c.unit, 0, getDisplay().units).value
                      : 1
                  }
                />
              </div>
            </>
          )}

          {canSwitchTeam && c.teams && (
            <div className="card stack" style={{ marginTop: 14, gap: 10 }}>
              <b>Your team</b>
              <TeamPicker
                teams={c.teams}
                value={c.myTeamId ?? null}
                disabled={busy}
                onChange={(teamId) =>
                  act(() => post(`/api/challenges/${id}/respond`, { accept: true, teamId }))
                }
              />
              <small className="muted">You can switch until the challenge starts.</small>
            </div>
          )}
          {c.teams && c.createdBy === user?.id && c.status === 'upcoming' && <ArrangeTeams c={c} />}
          <SeriesCard c={c} />

          {c.showEvents && c.myState === 'joined' && <ChallengeEvents c={c} />}

          {c.invited.length > 0 && (
            <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
              Waiting on {c.invited.map((u) => u.displayName.split(' ')[0]).join(', ')}
            </p>
          )}

          {c.status !== 'completed' && c.myState === 'joined' && (
            <div className="stack" style={{ marginTop: 20 }}>
              {!solo && (
                <button className="btn" onClick={() => invite().catch(setError)}>
                  <Icon name="share" size={18} /> Invite friends
                </button>
              )}
              {c.createdBy === user?.id && (c.status === 'upcoming' || solo) ? (
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
                  {solo ? 'Delete this solo challenge' : 'Delete challenge'}
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
