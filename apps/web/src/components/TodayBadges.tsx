/**
 * Badges and levels, where people look first: a level chip with an XP sliver in the Today header,
 * a compact card on Today (level, XP to the next level, newest badge) and the same card at the top
 * of the profile page. Each opens the badges screen. All of it reads the cheap /api/badges/summary,
 * and shows nothing in direct mode (no badges there).
 */
import type { BadgeSummary } from '@gauntlet/shared';
import { Link } from 'react-router';
import { cap } from '../lib/badges';
import { useBadgeSummary } from '../lib/ringQueries';
import { BadgeIcon } from './BadgeIcon';
import { Icon } from './Icon';
import '../styles/badges.css';
import '../styles/rings.css';

const pct = (s: BadgeSummary): number => {
  const span = s.level.nextLevelXp - s.level.levelXp;
  return span > 0 ? Math.max(0, Math.min(100, ((s.level.xp - s.level.levelXp) / span) * 100)) : 0;
};

export function LevelPill() {
  const q = useBadgeSummary();
  const s = q.data;
  if (!s) return null;
  const toGo = Math.max(0, s.level.nextLevelXp - s.level.xp);
  return (
    <Link
      to="/badges"
      className="lvl-pill"
      data-testid="level-pill"
      aria-label={`Level ${s.level.level}, ${toGo.toLocaleString('en-US')} XP to level ${s.level.level + 1}. Open badges`}
    >
      <span>Lv {s.level.level}</span>
      <span className="sliver" aria-hidden>
        <i style={{ width: `${pct(s)}%` }} />
      </span>
    </Link>
  );
}

/** "Level 7" with progress and the newest badge; the whole card opens the badges screen. */
export function BadgeProgressCard() {
  const q = useBadgeSummary();
  const s = q.data;
  if (!s) return null;
  const toGo = Math.max(0, s.level.nextLevelXp - s.level.xp);
  const latest = s.latest;
  const medal = latest && latest.tierName ? latest.tierName : latest ? ('single' as const) : null;
  return (
    <Link to="/badges" className="card bd-today" data-testid="badges-today">
      <div className="lv" aria-hidden>
        <small>Level</small>
        <b className="num">{s.level.level}</b>
      </div>
      <div className="main">
        <div className="xp">
          {toGo.toLocaleString('en-US')} XP <small>to level {s.level.level + 1}</small>
        </div>
        <div className="bd-xp" aria-hidden>
          <i style={{ width: `${pct(s)}%` }} />
        </div>
        <div className="newest">
          {latest
            ? `Newest: ${latest.tierName ? `${cap(latest.tierName)} ` : ''}${latest.name}`
            : 'No badges yet. Keep moving for your first.'}
        </div>
      </div>
      {latest && (
        <BadgeIcon icon={latest.icon} imageUrl={latest.imageUrl} medal={medal} size={40} />
      )}
      {s.unseenCount > 0 ? (
        <span className="newdot" aria-label={`${s.unseenCount} new`}>
          {s.unseenCount}
        </span>
      ) : (
        <Icon name="chevron" size={18} className="ring-chev" />
      )}
    </Link>
  );
}
