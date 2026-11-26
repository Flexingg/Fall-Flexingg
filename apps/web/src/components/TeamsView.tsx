/**
 * Team and series pieces of the challenge page: the team leaderboard, the team picker used when
 * joining, the creator's shuffle/move tools, and the "season" table for recurring challenges.
 */
import { TEAM_SCORING_LABELS, type ChallengeDetail, type ChallengeTeam } from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import '../styles/challenges-teams.css';
import { patch, post } from '../lib/api';
import { fmt, shortName } from '../lib/format';
import { Avatar, ErrorBox, toast } from './ui';

const tc = (color: string) => ({ '--tc': color }) as CSSProperties;

/** Choose a team: shown when joining or accepting, and until the start to switch. */
export function TeamPicker({
  teams,
  value,
  onChange,
  disabled,
}: {
  teams: ChallengeTeam[];
  value: string | null;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  // Same order as they were created, not by rank.
  return (
    <div className="team-picker" role="group" aria-label="Pick a team">
      {teams.map((t) => (
        <button
          key={t.id}
          type="button"
          style={tc(t.color)}
          aria-pressed={value === t.id}
          disabled={disabled}
          onClick={() => onChange(t.id)}
        >
          <span className="grow">
            {t.name}
            <small className="muted" style={{ display: 'block', fontWeight: 500 }}>
              {t.memberIds.length} {t.memberIds.length === 1 ? 'member' : 'members'}
            </small>
          </span>
        </button>
      ))}
    </div>
  );
}

/** Teams best first: name, colour, team score and how many people are on it. */
export function TeamLeaderboard({ c, showScores }: { c: ChallengeDetail; showScores: boolean }) {
  if (!c.teams?.length) return null;
  return (
    <>
      <div className="lbl" style={{ marginTop: 0 }}>
        <span>Teams</span>
        <span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>
          {c.teamScoring ? TEAM_SCORING_LABELS[c.teamScoring] : ''}
        </span>
      </div>
      <div className="list team-board" aria-label="Team leaderboard">
        {c.teams.map((t) => {
          const mine = t.id === c.myTeamId;
          return (
            <div
              key={t.id}
              className={`item${mine ? ' me' : ''}${t.rank === 1 && t.score != null ? ' first' : ''}`}
              style={tc(t.color)}
            >
              <span className="num" style={{ width: 18, color: 'var(--dim)', fontWeight: 800 }}>
                {t.score == null ? '–' : t.rank}
              </span>
              <div className="grow">
                <div className="t ellipsis">{t.name}</div>
                <small>
                  {t.memberIds.length} {t.memberIds.length === 1 ? 'member' : 'members'}
                  {mine ? ' · your team' : ''}
                </small>
              </div>
              {showScores && <div className="v num">{fmt(t.score, c)}</div>}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** For the creator before the start: shuffle everyone evenly, or move people one by one. */
export function ArrangeTeams({ c }: { c: ChallengeDetail }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const teams = c.teams ?? [];
  const joined = c.standings.filter((s) => s.state === 'joined');

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries();
      if (done) toast(done);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack arrange" style={{ marginTop: 14, gap: 10 }}>
      <b>Arrange teams</b>
      <small className="muted">You can change teams until the challenge starts.</small>
      <button
        className="btn secondary"
        disabled={busy || joined.length < 1}
        onClick={() => run(() => post(`/api/challenges/${c.id}/teams/shuffle`), 'Teams shuffled')}
      >
        Shuffle teams evenly
      </button>
      {joined.map((s) => (
        <div key={s.user.id} className="row">
          <Avatar user={s.user} size={32} />
          <span className="grow ellipsis">{s.isMe ? 'You' : shortName(s.user.displayName)}</span>
          <select
            aria-label={`Team for ${s.isMe ? 'you' : shortName(s.user.displayName)}`}
            value={s.teamId ?? ''}
            disabled={busy}
            onChange={(e) =>
              run(() =>
                patch(`/api/challenges/${c.id}/teams/${e.target.value}/members`, {
                  userIds: [s.user.id],
                }),
              )
            }
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      ))}
      <ErrorBox error={error} />
    </div>
  );
}

/** Round badge, links to the other rounds, and the season table for a recurring challenge. */
export function SeriesCard({ c }: { c: ChallengeDetail }) {
  const s = c.series;
  if (!s) return null;
  const links = [
    ...s.previous.map((r) => ({ ...r, label: `Round ${r.round}` })),
    ...(s.next ? [{ ...s.next, label: `Round ${s.next.round} →` }] : []),
  ];
  return (
    <div className="card stack" style={{ marginTop: 14, gap: 10 }} aria-label="Series">
      <div className="row">
        <b className="grow">Round {s.round}</b>
        {c.recurrence && (
          <span className="pill plain">{c.recurrence.every === 'week' ? 'Weekly' : 'Monthly'}</span>
        )}
      </div>
      {links.length > 0 && (
        <div className="round-links">
          {links.map((r) => (
            <Link key={r.id} to={`/c/${r.id}`} className="pill plain">
              {r.label}
            </Link>
          ))}
        </div>
      )}
      {s.season.length > 0 && (
        <table className="season" aria-label="Season table">
          <thead>
            <tr>
              <th>Season</th>
              <th>Wins</th>
              <th>Podiums</th>
              <th>Rounds</th>
            </tr>
          </thead>
          <tbody>
            {s.season.map((r) => (
              <tr key={r.user.id}>
                <td>{shortName(r.user.displayName)}</td>
                <td className="num">{r.wins}</td>
                <td className="num">{r.podiums}</td>
                <td className="num">{r.rounds}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {s.season.length === 0 && (
        <small className="muted">The season table appears once a round has finished.</small>
      )}
      <small className="muted">First place counts as a win; the top three count as podiums.</small>
    </div>
  );
}
