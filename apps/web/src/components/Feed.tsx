import type { ChallengeSummary, FeedEvent } from '@gauntlet/shared';
import { ordinal, SOLO_STATUS_LABELS } from '@gauntlet/shared';
import { Link } from 'react-router';
import { daysLeftText, fmt, timeAgo } from '../lib/format';
import { Icon } from './Icon';
import { Avatar } from './ui';

export function FeedList({ events }: { events: FeedEvent[] }) {
  return (
    <div className="list">
      {events.map((e) => (
        <div key={e.id} className="item">
          <Avatar
            user={e.actor}
            size={40}
            lead={
              e.kind === 'took_lead' || e.kind === 'challenge_won' || e.kind === 'personal_record'
            }
          />
          <div className="grow">
            <div className="t">{e.text}</div>
            <small>{[e.source, timeAgo(e.createdAt)].filter(Boolean).join(' · ')}</small>
          </div>
          {e.badge && <div className="v num">{e.badge}</div>}
        </div>
      ))}
    </div>
  );
}

/** The volt "you're 2nd, 3.1 km behind Maya" card. */
export function ChallengeHero({ c }: { c: ChallengeSummary }) {
  const amount = (v: number) =>
    c.unit ? fmt(v, c) : `${fmt(v, c)} ${c.metricLabel.toLowerCase()}`;
  let line: string;
  if (c.solo) {
    const st = SOLO_STATUS_LABELS[c.solo.status];
    line =
      c.solo.status === 'upcoming'
        ? 'Starts soon'
        : `${st} · ${Math.round(c.solo.progress * 100)}% of the way`;
  } else if (c.myScore == null || c.myRank == null) line = 'No data yet. Get moving.';
  else if (c.gap && c.gap.ahead)
    line = `${amount(c.gap.amount)} behind ${c.gap.user.displayName.split(' ')[0]}`;
  else if (c.gap && !c.gap.ahead)
    line = `${amount(c.gap.amount)} ahead of ${c.gap.user.displayName.split(' ')[0]}`;
  else line = `${amount(c.myScore)} so far`;
  return (
    <Link to={`/c/${c.id}`} className="hero">
      <div className="badge">
        {c.solo ? `${Math.round(c.solo.progress * 100)}%` : c.myRank ? ordinal(c.myRank) : '–'}
      </div>
      <div className="grow">
        <small className="ellipsis" style={{ display: 'block' }}>
          {c.name} · {daysLeftText(c)}
        </small>
        <b>{line}</b>
      </div>
      <Icon name="chevron" size={20} strokeWidth={2.5} />
    </Link>
  );
}
