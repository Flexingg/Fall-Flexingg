/**
 * Today's "Limited time" card: a badge with a deadline that you're still going for, with how far
 * along you are and how long is left. Tap for the badge. Nothing shows when none is running.
 */
import { todayIn } from '@gauntlet/shared';
import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { useBadgeCatalog } from '../lib/badgeQueries';
import { endsText, isLimitedRunning, progressPct } from '../lib/badges';
import { BadgeIcon, medalOf } from './BadgeIcon';
import { BadgeSheet } from './BadgeSheet';
import '../styles/badges.css';

export function LimitedBadges() {
  const { user } = useAuth();
  const q = useBadgeCatalog(user?.id ?? '', !!user);
  const [open, setOpen] = useState<string | null>(null);
  if (!user || !q.data) return null;
  const today = todayIn(user.timezone);
  const running = q.data.badges
    .filter((b) => isLimitedRunning(b, today))
    .sort((a, b) => a.window!.end.localeCompare(b.window!.end))
    .slice(0, 2);
  if (!running.length) return null;
  return (
    <>
      {running.map((b) => {
        const pct = Math.round(progressPct(b) * 100);
        return (
          <button
            key={b.key}
            className="bd-limited-card"
            onClick={() => setOpen(b.key)}
            data-testid="limited-badge"
            aria-label={`Limited time: ${b.name}. ${endsText(b.window!, today)}`}
          >
            <BadgeIcon icon={b.icon} imageUrl={b.imageUrl} medal={medalOf(b)} size="md" />
            <div className="grow">
              <small className="bd-limited-kick">Limited time</small>
              <b className="ellipsis">{b.name}</b>
              <div className="track" aria-hidden>
                <i style={{ width: `${pct}%` }} />
              </div>
              <small>
                {b.progress ? `${b.progress.label} · ` : ''}
                <span className="bd-ends">{endsText(b.window!, today)}</span>
              </small>
            </div>
          </button>
        );
      })}
      {open && (
        <BadgeSheet
          badgeKey={open}
          userId={user.id}
          initial={q.data.badges.find((b) => b.key === open)}
          showcase={q.data.showcase}
          level={q.data.level.level}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
