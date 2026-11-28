import { STAKE_MAX, STAKE_SUGGESTIONS, type ChallengeDetail } from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { post } from '../lib/api';
import { firstName } from '../lib/format';
import { ErrorBox } from './ui';
import '../styles/challenges.css';
import { invalidateSyncedData } from '../lib/syncedData';

/** "Side bet" input with a few tappable ideas. Plain text only; never about money. */
export function StakeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <label className="input">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={STAKE_MAX}
          placeholder="Optional"
          aria-label="Side bet"
        />
        <span>Side bet</span>
      </label>
      <div className="stake-suggest">
        {STAKE_SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={value.trim() === s}
            onClick={() => onChange(value.trim() === s ? '' : s)}
          >
            {s}
          </button>
        ))}
      </div>
      <small className="muted">
        Just for bragging rights. It is only text: Gauntlet never handles money.
      </small>
    </div>
  );
}

/** The side bet under a challenge's header. */
export function StakeChip({ stake, paid }: { stake: string; paid?: boolean }) {
  return (
    <div className={`stake-chip${paid ? ' paid' : ''}`} aria-label="Side bet">
      <span aria-hidden="true" style={{ fontSize: 20 }}>
        🤝
      </span>
      <div>
        <small>Side bet</small>
        <b>{stake}</b>
      </div>
    </div>
  );
}

function joinNames(list: string[]): string {
  return list.length < 2 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}

function names(users: { displayName: string }[], me: (i: number) => boolean) {
  return users.map((u, i) => (me(i) ? 'You' : firstName(u.displayName)));
}

/** Who owes the side bet once the challenge is over, with "Mark as paid up". */
export function StakeResult({ c }: { c: ChallengeDetail }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const info = c.stakeInfo;
  if (!c.stake || !info) return null;
  const meId = c.standings.find((s) => s.isMe)?.user.id;
  const owes = names(info.owedBy, (i) => info.owedBy[i]!.id === meId);
  const youOwe = owes.includes('You');
  const others = owes.filter((n) => n !== 'You');
  const paid = !!info.settledAt;

  async function settle(settled: boolean) {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/challenges/${c.id}/stake/settle`, { settled });
      await invalidateSyncedData(qc);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="card stack"
      style={{ gap: 8, textAlign: 'left', marginBottom: 14 }}
      aria-label="Side bet result"
    >
      <StakeChip stake={c.stake} paid={paid} />
      <div>
        {info.owedBy.length === 0 ? (
          <b>Nobody owes this one: it was a tie.</b>
        ) : (
          <b>
            {youOwe
              ? `You owe it${others.length ? ` with ${joinNames(others)}` : ''}`
              : `${joinNames(owes)} ${owes.length > 1 ? 'owe' : 'owes'} it`}
            {c.teams ? ' (losing team)' : ''}
          </b>
        )}
      </div>
      {paid ? (
        <div className="row">
          <b className="grow" style={{ color: 'var(--volt)' }}>
            Paid up ✓
          </b>
          {info.canSettle && (
            <button
              className="btn sm ghost"
              style={{ width: 'auto' }}
              disabled={busy}
              onClick={() => settle(false)}
            >
              Undo
            </button>
          )}
        </div>
      ) : (
        info.canSettle &&
        info.owedBy.length > 0 && (
          <button className="btn secondary" disabled={busy} onClick={() => settle(true)}>
            Mark as paid up
          </button>
        )
      )}
      <ErrorBox error={error} />
    </div>
  );
}

/** "Series: You 2 – 1 Maya" for two people, wins per person for more. */
export function SeriesRecord({ c }: { c: ChallengeDetail }) {
  const s = c.rematchSeries;
  if (!s || !s.entries.length) return null;
  const label = (e: (typeof s.entries)[number]) => (e.isMe ? 'You' : firstName(e.user.displayName));
  // Always show yourself first: "You 2 – 1 Maya".
  const sorted = [...s.entries].sort((a, b) => Number(b.isMe) - Number(a.isMe));
  const two = sorted.length === 2;
  return (
    <div className="series-record" aria-label="Rematch series">
      <small>Series · {s.rounds === 1 ? '1 round' : `${s.rounds} rounds`}</small>
      {two ? (
        <span className="score">
          {label(sorted[0]!)} {sorted[0]!.wins} – {sorted[1]!.wins} {label(sorted[1]!)}
        </span>
      ) : (
        sorted.slice(0, 5).map((e) => (
          <span key={e.user.id} className="score">
            {label(e)} {e.wins}
          </span>
        ))
      )}
    </div>
  );
}
