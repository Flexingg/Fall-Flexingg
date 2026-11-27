/**
 * The profile's Badges card (replaces the old milestones list): level, earned count, the three
 * showcase badges (pinned, else the best earned) and a link to everything. Shows nothing when the
 * person's badges are private (the server says 404) or there is nothing to show yet.
 */
import { Link } from 'react-router';
import { useState } from 'react';
import { pickShowcase, tierLabelOf } from '../lib/badges';
import { useBadgeCatalog } from '../lib/badgeQueries';
import { BadgeIcon, medalOf } from './BadgeIcon';
import { BadgeSheet } from './BadgeSheet';
import { Icon } from './Icon';
import '../styles/badges.css';

export function BadgesCard({
  userId,
  isMe,
  name,
}: {
  userId: string;
  isMe: boolean;
  name: string;
}) {
  const q = useBadgeCatalog(userId);
  const [open, setOpen] = useState<string | null>(null);
  const d = q.data;
  if (!d) return null;
  const top = pickShowcase(d.badges, d.showcase);
  const to = isMe ? '/badges' : `/u/${userId}/badges`;
  return (
    <section data-testid="badges-card">
      <div className="lbl">
        <span>Badges</span>
        <Link to={to}>See all</Link>
      </div>
      <div className="card bd-card">
        <div className="bd-card-top">
          <div className="bd-lvl-big" aria-label={`Level ${d.level.level}`}>
            <small>Level</small>
            <b className="num">{d.level.level}</b>
          </div>
          <div className="grow">
            <div style={{ fontWeight: 700 }}>
              {d.earnedCount} badge{d.earnedCount === 1 ? '' : 's'} earned
            </div>
            <small className="muted">
              {d.level.xp.toLocaleString('en-US')} XP{isMe ? ' · tap a badge to pin it here' : ''}
            </small>
          </div>
          <Link to={to} aria-label="See all badges" className="muted">
            <Icon name="chevron" size={18} />
          </Link>
        </div>
        {top.length > 0 ? (
          <div className="bd-showcase">
            {top.map((b) => (
              <button
                key={b.key}
                className="bd-show"
                onClick={() => setOpen(b.key)}
                aria-label={`${b.name}${tierLabelOf(b) ? `, ${tierLabelOf(b)}` : ''}`}
              >
                <BadgeIcon icon={b.icon} imageUrl={b.imageUrl} medal={medalOf(b)} size="lg" />
                <span>{b.name}</span>
                <small>{tierLabelOf(b) ?? 'Earned'}</small>
              </button>
            ))}
          </div>
        ) : (
          <small className="muted">
            {isMe
              ? 'No badges yet. Keep moving and your first one lands soon.'
              : `${name} hasn't earned a badge yet.`}
          </small>
        )}
      </div>
      {open && (
        <BadgeSheet
          badgeKey={open}
          userId={userId}
          initial={d.badges.find((b) => b.key === open)}
          showcase={d.showcase}
          who={name}
          level={d.level.level}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}
