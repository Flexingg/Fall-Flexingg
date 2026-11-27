/**
 * What happens when you earn a badge. On app open, when you come back to it, and after a sync the
 * app asks which badges you haven't seen yet. Gold, platinum, secret one-tier and limited-time
 * badges get a full-screen moment (the badge drops in with the same impact ring and dust as the
 * launch splash, a heavy haptic on Android): tier, XP, and a level-up line when the level changed.
 * Tap anywhere to move on. At most three of those per batch; everything else, bronze and silver
 * included, is one toast. Reduced motion shows the same card without the movement. Each badge is
 * marked seen once it has been shown, so it never plays twice.
 */
import type { BadgeView } from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { badgeKeys, useUnseenBadges } from '../lib/badgeQueries';
import { shareBadge, toastForShare } from '../lib/badgeShare';
import { cap, earnedLine, planCelebration, tierLabelOf, type CelebrationPlan } from '../lib/badges';
import { impact } from '../lib/haptics';
import { BadgeIcon, medalOf } from './BadgeIcon';
import { Icon } from './Icon';
import { toast } from './ui';
import '../styles/badges.css';

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

function kicker(b: BadgeView): string {
  if (b.window) return 'Limited time badge';
  if (b.secret && b.tiers.length === 1) return 'Secret badge found';
  return 'Badge earned';
}

export function BadgeCelebration({ hold = false }: { hold?: boolean }) {
  const { status, mode, user } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useUnseenBadges(status === 'signedIn' && mode === 'server' && !user?.demo && !hold);
  // Badges already queued or shown, so a refetch while one is on screen can't repeat it.
  const handled = useRef(new Set<string>());
  const [plans, setPlans] = useState<CelebrationPlan[]>([]);
  const [index, setIndex] = useState(0);
  const plan = plans[0];
  const current = plan?.full[index];

  const markSeen = useCallback(
    (keys: string[]) => {
      if (!keys.length) return;
      post('/api/badges/seen', { keys })
        .then(() => qc.invalidateQueries({ queryKey: badgeKeys.all }))
        .catch(() => undefined);
    },
    [qc],
  );

  /** The toast for everything that didn't get its own screen. */
  const tellQuiet = useCallback(
    (p: CelebrationPlan) => {
      if (!p.quiet.length) return;
      const one = p.quiet.length === 1 ? p.quiet[0]! : null;
      toast(one ? `You earned ${earnedLine(one)}` : `You earned ${p.quiet.length} more badges`, {
        icon: one ? (
          <BadgeIcon icon={one.icon} imageUrl={one.imageUrl} medal={medalOf(one)} size={36} />
        ) : undefined,
        action: { label: 'See', onClick: () => navigate('/badges') },
        duration: 4500,
      });
      markSeen(p.quiet.map((b) => b.key));
    },
    [markSeen, navigate],
  );

  useEffect(() => {
    if (!q.data || hold) return;
    const fresh = q.data.badges.filter((b) => !handled.current.has(`${b.key}:${b.tier}`));
    if (!fresh.length) return;
    fresh.forEach((b) => handled.current.add(`${b.key}:${b.tier}`));
    const next = planCelebration(fresh, q.data.level);
    if (next.full.length) setPlans((p) => [...p, next]);
    else tellQuiet(next);
  }, [q.data, hold, tellQuiet]);

  // The moment lands: a heavy thump.
  useEffect(() => {
    if (current && !reduced()) impact();
  }, [current]);

  const next = useCallback(() => {
    if (!plan || !current) return;
    markSeen([current.key]);
    if (index + 1 < plan.full.length) setIndex(index + 1);
    else {
      tellQuiet(plan);
      setIndex(0);
      setPlans((p) => p.slice(1));
    }
  }, [plan, current, index, markSeen, tellQuiet]);

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => (e.key === 'Escape' || e.key === 'Enter') && next();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, next]);

  if (!plan || !current) return null;
  const tier = tierLabelOf(current);
  const first = index === 0;
  return (
    <div
      className={`cele${reduced() ? ' still' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Badge earned: ${earnedLine(current)}`}
      onClick={next}
      data-testid="celebration"
    >
      <div className="cele-card" key={current.key}>
        <div className="cele-stage">
          <div className="cele-dust" aria-hidden>
            {[-3, -2, -1, 1, 2, 3].map((d) => (
              <i key={d} style={{ ['--d' as string]: d }} />
            ))}
          </div>
          <div className="cele-ring" aria-hidden />
          <div className="cele-medal">
            <BadgeIcon
              icon={current.icon}
              imageUrl={current.imageUrl}
              medal={medalOf(current)}
              size={168}
            />
          </div>
        </div>
        <div className="cele-kicker">{kicker(current)}</div>
        {tier && (
          <div
            className="cele-tier"
            style={{ color: `var(--tier-${tier.toLowerCase()}, var(--text))` }}
          >
            {cap(tier)}
          </div>
        )}
        <div className="cele-name">{current.name}</div>
        <div className="cele-desc">{current.description}</div>
        {first && plan.xp > 0 && <div className="cele-xp">+{plan.xp} XP</div>}
        {first && plan.leveledUpFrom != null && (
          <div className="cele-level">Level up! You're now level {plan.level.level}</div>
        )}
        <div className="cele-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="btn secondary"
            onClick={async () => {
              const r = await shareBadge({ badge: current, who: 'You', level: plan.level.level });
              const msg = toastForShare(r);
              if (msg) toast(msg);
            }}
          >
            <Icon name="share" size={18} /> Share
          </button>
          <button className="btn" onClick={next}>
            Nice
          </button>
        </div>
        {plan.full.length > 1 && (
          <small className="muted">
            {index + 1} of {plan.full.length}
          </small>
        )}
      </div>
      <div className="cele-hint">Tap anywhere to continue</div>
    </div>
  );
}
