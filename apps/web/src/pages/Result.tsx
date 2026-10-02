import { ordinal, type ChallengeDetail } from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { SoloCard, soloSentence } from '../components/SoloCard';
import { ErrorBox, Header, Screen, Skeleton } from '../components/ui';
import { post } from '../lib/api';
import { fmt, shortName } from '../lib/format';
import { useResult } from '../lib/queries';

function headline(rank: number | null, n: number): string {
  if (rank == null) return 'No data';
  if (rank === 1) return 'You won.';
  if (rank === 2) return 'So close.';
  if (rank === n) return 'Next time.';
  return 'Solid effort.';
}

export function ResultPage() {
  const { id = '' } = useParams();
  const q = useResult(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const r = q.data;
  const c = r?.challenge;

  async function rematch() {
    setBusy(true);
    try {
      const next = await post<ChallengeDetail>(`/api/challenges/${id}/rematch`);
      await qc.invalidateQueries();
      navigate(`/c/${next.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const leader = c?.standings[0];
  // "16,000 steps" rather than a bare "16,000" for unitless metrics.
  const amount = (v: number) =>
    c!.unit ? fmt(v, c!) : `${fmt(v, c!)} ${c!.metricLabel.toLowerCase()}`;
  const sub =
    !r?.me?.rank || !c
      ? ''
      : r.me.rank === 1
        ? c.standings[1]?.score != null && r.me.score != null
          ? `You beat ${shortName(c.standings[1].user.displayName).split(' ')[0]} by ${amount(Math.abs(r.me.score - c.standings[1].score))}.`
          : 'Nobody could keep up.'
        : leader && leader.score != null && r.me.score != null
          ? `You finished ${amount(Math.abs(leader.score - r.me.score))} behind ${leader.user.displayName.split(' ')[0]}.`
          : '';

  return (
    <Screen>
      <Header title=" " back="/challenges" />
      <ErrorBox error={q.error ?? error} />
      {q.isPending && <Skeleton height={400} />}
      {c && r && c.solo && (
        <div className="center">
          <div className="lbl" style={{ justifyContent: 'center', marginTop: 0 }}>
            {c.name} · Final
          </div>
          <div className="big" style={{ fontSize: 36, margin: '18px 0 8px' }}>
            {c.solo.status === 'achieved' ? 'You did it.' : 'Not this time.'}
          </div>
          <p className="muted" style={{ fontSize: 15, margin: '0 0 22px' }}>
            {soloSentence(c)}
          </p>
          <SoloCard c={c} />
          {r.me && (
            <div className="pb" style={{ marginTop: 14, textAlign: 'left' }}>
              <div>
                <b className="num">{fmt(r.me.bestDay, { ...c, unit: '' }, false)}</b>
                <span>Best day</span>
              </div>
              <div>
                <b className="num">{r.me.daysWithData}</b>
                <span>Active days</span>
              </div>
            </div>
          )}
          <div className="dock">
            <button className="btn" onClick={rematch} disabled={busy}>
              {busy ? <span className="spinner" /> : 'Run it again'}
            </button>
          </div>
        </div>
      )}
      {c && r && !c.solo && (
        <div className="center">
          <div className="lbl" style={{ justifyContent: 'center', marginTop: 0 }}>
            {c.name} · Final
          </div>
          <div
            className="av lead"
            style={{
              width: 96,
              height: 96,
              fontSize: 30,
              fontWeight: 900,
              margin: '18px auto 14px',
            }}
          >
            {r.me?.rank ? ordinal(r.me.rank) : '–'}
          </div>
          <div className="big" style={{ fontSize: 36 }}>
            {headline(r.me?.rank ?? null, c.standings.length)}
          </div>
          <p className="muted" style={{ fontSize: 15, margin: '8px 0 22px' }}>
            {sub}
          </p>
          <div className="list" style={{ textAlign: 'left' }}>
            {c.standings.slice(0, 5).map((s) => (
              <div
                key={s.user.id}
                className={`item${s.isMe ? ' me' : ''}`}
                style={{ minHeight: 48 }}
              >
                <span className="num" style={{ width: 18, color: 'var(--dim)', fontWeight: 800 }}>
                  {s.rank}
                </span>
                <span className="grow t">{s.isMe ? 'You' : shortName(s.user.displayName)}</span>
                <span className="v num">{fmt(s.score, c)}</span>
              </div>
            ))}
          </div>
          {r.me && (
            <div className="pb" style={{ marginTop: 14, textAlign: 'left' }}>
              <div>
                <b className="num">{fmt(r.me.bestDay, c, false)}</b>
                <span>Best day{c.unit ? ` (${c.unit})` : ''}</span>
              </div>
              <div>
                <b className="num">{r.me.daysWithData}</b>
                <span>Active days</span>
              </div>
            </div>
          )}
          <div className="dock">
            <button className="btn" onClick={rematch} disabled={busy}>
              {busy ? <span className="spinner" /> : 'Rematch'}
            </button>
          </div>
        </div>
      )}
    </Screen>
  );
}
