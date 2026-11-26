import type { ChallengeDetail, StandingRow } from '@gauntlet/shared';
import { Link } from 'react-router';
import { fmt, shortName } from '../lib/format';
import { Avatar } from './ui';

export function Podium({ challenge }: { challenge: ChallengeDetail }) {
  const ranked = challenge.standings.filter((s) => s.score != null).slice(0, 3);
  if (ranked.length < 2) return null;
  // Classic podium order: 2nd, 1st, 3rd.
  const order = [ranked[1], ranked[0], ranked[2]].filter((s): s is StandingRow => !!s);
  const heights = { 1: 84, 2: 68, 3: 54 } as Record<number, number>;
  return (
    <div className="podium" aria-label="Top three">
      {order.map((s) => {
        const place = Math.min(s.rank, 3);
        return (
          <div key={s.user.id} className={`pd${place === 1 ? ' first' : ''}`}>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <Avatar
                user={s.user}
                size={place === 1 ? 60 : place === 2 ? 52 : 48}
                lead={place === 1}
                me={s.isMe && place !== 1}
              />
            </div>
            <small>{s.isMe ? 'You' : shortName(s.user.displayName).split(' ')[0]}</small>
            <div className="step num" style={{ height: heights[place] }}>
              {fmt(s.score, challenge, false)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function StandingsList({
  challenge,
  showToday,
}: {
  challenge: ChallengeDetail;
  showToday?: boolean;
}) {
  const scores = challenge.standings.map((s) => s.score ?? 0);
  const top =
    challenge.goal && challenge.scoring === 'race_to_goal'
      ? challenge.goal
      : Math.max(...scores, 0);
  return (
    <div className="list">
      {challenge.standings.map((s) => {
        const pct = challenge.lowerIsBetter
          ? s.score
            ? Math.min(Math.min(...scores.filter((x) => x > 0)) / s.score, 1)
            : 0
          : top > 0
            ? Math.min((s.score ?? 0) / top, 1)
            : 0;
        return (
          <Link
            key={s.user.id}
            to={`/u/${s.user.id}`}
            className={`item${s.isMe ? ' me' : ''}`}
            aria-label={`${s.isMe ? 'You' : s.user.displayName}, profile`}
          >
            <span className="num" style={{ width: 18, color: 'var(--dim)', fontWeight: 800 }}>
              {s.score == null ? '–' : s.rank}
            </span>
            <div className="grow">
              <div className="t ellipsis">{s.isMe ? 'You' : shortName(s.user.displayName)}</div>
              <div className="track">
                <i style={{ width: `${pct * 100}%` }} />
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="v num">{fmt(s.score, challenge)}</div>
              {showToday && s.todayValue != null && (
                <small className="muted num">+{fmt(s.todayValue, challenge, false)} today</small>
              )}
              {s.reachedGoalOn && <small style={{ color: 'var(--volt)' }}>Finished</small>}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
