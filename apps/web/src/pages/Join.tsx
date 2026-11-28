import type { InvitePreview } from '@gauntlet/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { StakeChip } from '../components/Stake';
import { Avatar, ErrorBox, Screen, ShowEventsNotice, Skeleton } from '../components/ui';
import { post, publicGet } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateRange } from '../lib/format';
import { invalidateSyncedData } from '../lib/syncedData';

export function JoinPage() {
  const { code = '' } = useParams();
  const { status } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const preview = useQuery({
    queryKey: ['invite', code],
    queryFn: () => publicGet<InvitePreview>(`/api/invites/${encodeURIComponent(code)}`),
    retry: false,
  });

  if (status === 'signedOut' && preview.isSuccess) {
    return <Navigate to="/login" replace state={{ next: `/j/${code}` }} />;
  }

  async function accept() {
    setBusy(true);
    try {
      const r = await post<{ challengeId: string | null }>(
        `/api/invites/${encodeURIComponent(code)}/accept`,
      );
      await invalidateSyncedData(qc);
      navigate(r.challengeId ? `/c/${r.challengeId}` : '/friends', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const p = preview.data;
  return (
    <Screen tabs={false}>
      <div className="center" style={{ marginTop: '14vh' }}>
        <ErrorBox error={preview.error ?? error} />
        {preview.isPending && <Skeleton height={200} />}
        {p && (
          <>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <Avatar user={p.from} size={80} lead />
            </div>
            <h1
              style={{
                fontSize: 28,
                fontWeight: 900,
                letterSpacing: '-0.02em',
                margin: '18px 0 8px',
              }}
            >
              {p.challenge
                ? `${p.from.displayName.split(' ')[0]} challenged you`
                : `${p.from.displayName.split(' ')[0]} wants to compete`}
            </h1>
            {p.challenge ? (
              <p className="muted" style={{ fontSize: 15 }}>
                <b style={{ color: 'var(--text)' }}>{p.challenge.name}</b> ·{' '}
                {p.challenge.metricLabel} · {dateRange(p.challenge.startDate, p.challenge.endDate)}
              </p>
            ) : (
              <p className="muted" style={{ fontSize: 15 }}>
                Accept to add each other as friends on Gauntlet.
              </p>
            )}
            {p.challenge?.stake && <StakeChip stake={p.challenge.stake} />}
            {p.challenge?.showEvents && (
              <div style={{ marginTop: 14 }}>
                <ShowEventsNotice />
              </div>
            )}
            <div className="stack" style={{ marginTop: 28 }}>
              <button className="btn" onClick={accept} disabled={busy}>
                {busy ? (
                  <span className="spinner" />
                ) : p.challenge ? (
                  'Accept challenge'
                ) : (
                  'Add friend'
                )}
              </button>
              <button className="btn ghost" onClick={() => navigate('/')}>
                Not now
              </button>
            </div>
          </>
        )}
      </div>
    </Screen>
  );
}
