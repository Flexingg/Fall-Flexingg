import { SCORING_LABELS } from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Icon } from '../components/Icon';
import { Podium, StandingsList } from '../components/Standings';
import { ErrorBox, Header, Screen, Skeleton, toast } from '../components/ui';
import { del, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateRange, daysLeftText, fmt } from '../lib/format';
import { keys, useChallenge } from '../lib/queries';
import { shareLink } from '../lib/share';
import type { Invite } from '@gauntlet/shared';

export function ChallengeDetailPage() {
  const { id = '' } = useParams();
  const q = useChallenge(id);
  const { user } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const c = q.data;

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
      <Header title={c?.name ?? ' '} back="/challenges" />
      <ErrorBox error={q.error ?? error} />
      {q.isPending && <Skeleton height={320} />}
      {c && (
        <>
          <p className="muted" style={{ marginTop: -8, marginBottom: 14, fontSize: 14 }}>
            {c.metricLabel} · {SCORING_LABELS[c.scoring]}
            {c.goal ? ` · ${fmt(c.goal, c)}${c.scoring === 'streak' ? '/day' : ''}` : ''} ·{' '}
            {dateRange(c.startDate, c.endDate)} · {daysLeftText(c)}
          </p>

          {c.myState === 'invited' && (
            <div className="card stack" style={{ marginBottom: 14 }}>
              <b>You're invited</b>
              <div className="row">
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => act(() => post(`/api/challenges/${id}/respond`, { accept: true }))}
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
        </>
      )}
    </Screen>
  );
}
