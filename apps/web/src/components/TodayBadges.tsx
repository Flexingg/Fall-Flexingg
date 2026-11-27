/**
 * Level, where people look first: a chip with an XP sliver in the Today header and on the profile
 * page. It opens the badges screen. Reads the cheap /api/badges/summary, and shows nothing in
 * direct mode (no badges there).
 */
import type { BadgeSummary } from '@gauntlet/shared';
import { Link } from 'react-router';
import { useBadgeSummary } from '../lib/ringQueries';
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
