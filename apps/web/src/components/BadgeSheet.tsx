/**
 * One badge, big: the medal, what it takes, every tier with the day you got it, where it happened
 * (links to the challenge), how many friends have it, and, on your own earned badges, pin to your
 * profile (three at most) and share a picture.
 */
import { tierName, todayIn, type BadgeView } from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { badgeKeys, useBadgeDetail } from '../lib/badgeQueries';
import { shareBadge, toastForShare } from '../lib/badgeShare';
import { endsText, earnedLine, progressPct } from '../lib/badges';
import { fmtDate, fmtInt } from '../lib/format';
import { BadgeIcon, medalOf } from './BadgeIcon';
import { Icon } from './Icon';
import { toast } from './ui';
import '../styles/badges.css';

const day = (iso: string) => fmtDate(iso, { month: 'short', day: 'numeric', year: 'numeric' });

export function BadgeSheet({
  badgeKey,
  userId,
  initial,
  showcase,
  who,
  level,
  onClose,
}: {
  badgeKey: string;
  /** Whose badge it is. */
  userId: string;
  initial?: BadgeView;
  showcase: string[];
  /** First name of the owner, for someone else's badge. */
  who?: string;
  level?: number;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const q = useBadgeDetail(badgeKey, userId);
  const [busy, setBusy] = useState(false);
  const b = q.data?.badge ?? initial;
  const own = user?.id === userId;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!b) {
    return (
      <div
        className="bd-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Badge"
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        <div className="bd-sheet stack">
          <div className="bd-grab" />
          {q.error instanceof ApiError ? (
            <div className="error">{q.error.message}</div>
          ) : (
            <small className="muted">Loading…</small>
          )}
          <button className="btn secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  const earned = b.tier > 0;
  const pinned = showcase.includes(b.key);
  const today = user ? todayIn(user.timezone) : '';

  async function togglePin() {
    if (!b) return;
    if (!pinned && showcase.length >= 3) {
      toast('You can pin up to 3 badges. Unpin one first.');
      return;
    }
    setBusy(true);
    try {
      const keys = pinned ? showcase.filter((k) => k !== b.key) : [...showcase, b.key];
      await put('/api/me/showcase', { keys });
      await qc.invalidateQueries({ queryKey: badgeKeys.all });
      toast(pinned ? 'Unpinned from your profile' : 'Pinned to your profile');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    if (!b) return;
    const r = await shareBadge({
      badge: b,
      who: own ? 'You' : (who ?? 'Someone'),
      level,
      when: b.earnedAt ? day(b.earnedAt) : null,
    });
    const msg = toastForShare(r);
    if (msg) toast(msg);
  }

  const contexts = (q.data?.history ?? []).flatMap((h) => {
    const c = h.context as { challengeId?: string; challengeName?: string; date?: string };
    const out: { key: string; to?: string; label: string }[] = [];
    if (c.challengeId)
      out.push({
        key: `${h.tier}-c`,
        to: `/c/${c.challengeId}`,
        label: c.challengeName ?? 'The challenge',
      });
    if (c.date)
      out.push({
        key: `${h.tier}-d`,
        label: fmtDate(c.date, { month: 'short', day: 'numeric', year: 'numeric' }),
      });
    return out;
  });

  return (
    <div
      className="bd-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={b.hidden ? 'Secret badge' : `Badge: ${b.name}`}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bd-sheet stack" style={{ gap: 16 }}>
        <div className="bd-grab" />
        <div className="bd-sheet-top">
          <BadgeIcon
            icon={b.icon}
            imageUrl={b.imageUrl}
            medal={medalOf(b)}
            hidden={b.hidden}
            size="xl"
          />
          <h2>{b.hidden ? 'Secret badge' : b.name}</h2>
          <p>{b.description}</p>
          {earned && (
            <small className="muted" data-testid="badge-earned-line">
              {earnedLine(b)}
              {b.earnedAt ? ` · ${day(b.earnedAt)}` : ''}
            </small>
          )}
          {b.window && !earned && <small className="bd-ends">{endsText(b.window, today)}</small>}
        </div>

        {b.progress && (
          <div>
            <div className="row" style={{ justifyContent: 'space-between', fontSize: 13 }}>
              <span className="muted">Next tier</span>
              <b className="num">{b.progress.label}</b>
            </div>
            <div className="track">
              <i
                style={{ width: `${Math.round(progressPct(b) * 100)}%`, background: 'var(--volt)' }}
              />
            </div>
          </div>
        )}

        {!b.hidden && b.tiers.length > 0 && (
          <div className="bd-ladder" aria-label="Tiers">
            {b.tiers.map((t) => {
              const done = t.tier <= b.tier;
              const tn = tierName(t.tier, b.tiers.length);
              return (
                <div key={t.tier} className={`bd-rung${done ? '' : ' todo'}`}>
                  <BadgeIcon
                    icon={b.icon}
                    imageUrl={b.imageUrl}
                    medal={done ? (tn ?? 'single') : null}
                    size="sm"
                  />
                  <div className="grow">
                    <div className="t">
                      {tn ? `${tn.charAt(0).toUpperCase()}${tn.slice(1)}` : 'Earned'}
                    </div>
                    <small>{t.label}</small>
                  </div>
                  <small className="num">
                    {done ? (t.earnedAt ? day(t.earnedAt) : 'Earned') : `+${t.xp} XP`}
                  </small>
                </div>
              );
            })}
          </div>
        )}

        {contexts.length > 0 && (
          <div className="bd-ctx">
            {contexts.map((c) =>
              c.to ? (
                <Link key={c.key} to={c.to} onClick={onClose}>
                  {c.label} <Icon name="chevron" size={12} />
                </Link>
              ) : (
                <span key={c.key} className="pill plain">
                  {c.label}
                </span>
              ),
            )}
          </div>
        )}

        {q.data && !b.hidden && (
          <small className="muted" data-testid="badge-friends">
            {q.data.friendsWithIt === 1
              ? '1 friend has this'
              : `${q.data.friendsWithIt} friends have this`}
            {' · '}
            {q.data.earnedByCount === 1 ? '1 person' : `${fmtInt(q.data.earnedByCount)} people`}
          </small>
        )}

        <div className="stack" style={{ gap: 8 }}>
          {own && earned && (
            <button className="btn" onClick={() => void togglePin()} disabled={busy}>
              {pinned ? 'Unpin from profile' : 'Pin to profile'}
            </button>
          )}
          {earned && (
            <button className="btn secondary" onClick={() => void share()}>
              <Icon name="share" size={18} /> Share
            </button>
          )}
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
