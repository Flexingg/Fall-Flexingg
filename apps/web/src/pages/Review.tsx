/**
 * Month / year in review: a story of full-screen cards. Tap the right side (or press →) to go on,
 * the left side (←) to go back, swipe either way, Esc or Close to leave. It never plays by itself
 * and slides only when the phone allows motion. Always your own numbers.
 */
import {
  compactNumber,
  parsePeriod,
  type BadgeView,
  type RecapTotal,
  type Review,
} from '@gauntlet/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { BadgeIcon, medalOf } from '../components/BadgeIcon';
import { Icon } from '../components/Icon';
import { ErrorBox, Skeleton, toast } from '../components/ui';
import { useAuth } from '../lib/auth';
import { useBadgeCatalog } from '../lib/badgeQueries';
import { tierLabelOf, xpOf } from '../lib/badges';
import { useReview } from '../lib/reviewQueries';
import { shareLink } from '../lib/share';
import '../styles/review.css';

interface StoryCard {
  key: string;
  tone: 'dark' | 'lime';
  body: ReactNode;
}

const amount = (t: RecapTotal) =>
  t.value.toLocaleString('en-US', {
    minimumFractionDigits: t.decimals,
    maximumFractionDigits: t.decimals,
  });
const n = (v: number) => Math.round(v).toLocaleString('en-US');
const longDay = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

/** "12% more steps than October" (or fewer); null when there is nothing to compare with. */
function versus(t: RecapTotal, noun: string, prev: string): string | null {
  if (t.changePct == null) return null;
  if (t.changePct === 0) return `The same ${noun} as ${prev}`;
  return `${Math.abs(t.changePct)}% ${t.changePct > 0 ? 'more' : 'fewer'} ${noun} than ${prev}`;
}

function buildCards(
  r: Review,
  badges: BadgeView[],
  onShare: () => void,
  onClose: () => void,
): StoryCard[] {
  const year = r.kind === 'year';
  const total = (k: string) => r.totals.find((t) => t.key === k)!;
  const steps = total('steps');
  const cards: StoryCard[] = [];

  cards.push({
    key: 'intro',
    tone: 'lime',
    body: (
      <>
        <div className="story-kicker">Gauntlet</div>
        <div className="story-title">
          {year ? `Your ${r.label}` : `Your ${r.label.split(' ')[0]}`}
        </div>
        <div className="story-line">in review{r.partial ? ' so far' : ''}</div>
        <div className="story-sub">
          {r.activeDays} active day{r.activeDays === 1 ? '' : 's'}. Tap to begin.
        </div>
      </>
    ),
  });

  if (steps.value > 0) {
    const cmp = versus(steps, 'steps', r.prevLabel);
    cards.push({
      key: 'steps',
      tone: 'dark',
      body: (
        <>
          <div className="story-kicker">You took</div>
          <div className="story-big num">{n(steps.value)}</div>
          <div className="story-line">steps</div>
          {cmp && (
            <div className={`story-sub${steps.changePct! > 0 ? ' story-up' : ''}`}>
              {steps.changePct! > 0 ? '▲ ' : steps.changePct! < 0 ? '▼ ' : ''}
              {cmp}
            </div>
          )}
        </>
      ),
    });
  }

  const others = r.totals.filter((t) => t.key !== 'steps' && t.value > 0);
  if (others.length) {
    cards.push({
      key: 'totals',
      tone: 'dark',
      body: (
        <>
          <div className="story-kicker">Also in {year ? 'the year' : r.label.split(' ')[0]}</div>
          <div className="story-grid">
            {others.map((t) => (
              <div key={t.key}>
                <b className="num">
                  {amount(t)}
                  {t.unit ? <small style={{ fontSize: 16 }}> {t.unit}</small> : null}
                </b>
                <span>{t.label}</span>
                {t.changePct != null && t.changePct !== 0 && (
                  <div className="recap-change">
                    <small>
                      {t.changePct > 0 ? '▲' : '▼'} {Math.abs(t.changePct)}% vs {r.prevLabel}
                    </small>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      ),
    });
  }

  if (r.bestDay) {
    cards.push({
      key: 'best-day',
      tone: 'lime',
      body: (
        <>
          <div className="story-kicker">Your best day</div>
          <div className="story-title">{longDay(r.bestDay.date)}</div>
          <div className="story-big num">{n(r.bestDay.steps)}</div>
          <div className="story-line">steps</div>
        </>
      ),
    });
  }

  if (r.longestStreak) {
    cards.push({
      key: 'streak',
      tone: 'dark',
      body: (
        <>
          <div className="story-kicker">Longest streak</div>
          <div className="story-big num">{r.longestStreak.days}</div>
          <div className="story-line">days in a row over {n(r.streakTarget)} steps</div>
          <div className="story-sub">
            {longDay(r.longestStreak.start)} to {longDay(r.longestStreak.end)}
          </div>
        </>
      ),
    });
  }

  if (r.weekday) {
    cards.push({
      key: 'weekday',
      tone: 'dark',
      body: (
        <>
          <div className="story-kicker">Your day</div>
          <div className="story-title">{r.weekday.name}s</div>
          <div className="story-line">
            You averaged {n(r.weekday.avgSteps)} steps on {r.weekday.name}s
          </div>
          <div className="story-sub">Across every day it was {n(r.weekday.overallAvg)}.</div>
        </>
      ),
    });
  }

  if (r.bestMonth) {
    cards.push({
      key: 'best-month',
      tone: 'lime',
      body: (
        <>
          <div className="story-kicker">Your biggest month</div>
          <div className="story-title">{r.bestMonth.label}</div>
          <div className="story-big num">{compactNumber(r.bestMonth.steps)}</div>
          <div className="story-line">steps</div>
        </>
      ),
    });
  }

  if (r.records.length) {
    cards.push({
      key: 'records',
      tone: 'dark',
      body: (
        <>
          <div className="story-kicker">Personal records</div>
          <div className="story-title">
            {r.records.length} new best{r.records.length === 1 ? '' : 's'}
          </div>
          <div className="story-list">
            {r.records.slice(0, 6).map((x) => (
              <div key={`${x.label}-${x.date}`}>
                <span>{x.label}</span>
                <b className="num">{x.badge}</b>
              </div>
            ))}
          </div>
        </>
      ),
    });
  }

  if (r.challenges.played > 0) {
    cards.push({
      key: 'challenges',
      tone: 'dark',
      body: (
        <>
          <div className="story-kicker">Challenges</div>
          <div className="story-title">{r.challenges.played} played</div>
          <div className="story-grid">
            <div>
              <b className="num">{r.challenges.won}</b>
              <span>Won</span>
            </div>
            <div>
              <b className="num">{r.challenges.podiums}</b>
              <span>Podiums</span>
            </div>
          </div>
        </>
      ),
    });
  }

  // Badges whose newest tier landed inside this period (skipped quietly when there are none).
  const won = badges
    .filter(
      (b) => b.earnedAt && b.earnedAt.slice(0, 10) >= r.start && b.earnedAt.slice(0, 10) <= r.end,
    )
    .sort((a, b) => b.tier / b.tiers.length - a.tier / a.tiers.length || xpOf(b) - xpOf(a));
  if (won.length) {
    cards.push({
      key: 'badges',
      tone: 'dark',
      body: (
        <>
          <div className="story-kicker">
            Badges you earned {year ? 'this year' : `in ${r.label.split(' ')[0]}`}
          </div>
          <div className="story-title">
            {won.length} badge{won.length === 1 ? '' : 's'}
          </div>
          <div className="story-badges">
            {won.slice(0, 6).map((b) => (
              <div key={b.key}>
                <BadgeIcon icon={b.icon} imageUrl={b.imageUrl} medal={medalOf(b)} size="lg" />
                <span>{b.name}</span>
                <small>{tierLabelOf(b) ?? 'Earned'}</small>
              </div>
            ))}
          </div>
          {won.length > 6 && <div className="story-sub">and {won.length - 6} more</div>}
        </>
      ),
    });
  }

  if (r.rival) {
    const v = r.rival;
    const first = v.displayName.split(' ')[0];
    cards.push({
      key: 'rival',
      tone: 'lime',
      body: (
        <>
          <div className="story-kicker">Top rival</div>
          <div className="story-title">{v.displayName}</div>
          <div className="story-line">
            {v.shared} challenge{v.shared === 1 ? '' : 's'} together
          </div>
          <div className="story-sub">
            {v.wins === v.losses
              ? `All square with ${first}: ${v.wins} each.`
              : v.wins > v.losses
                ? `You finished ahead of ${first} ${v.wins} time${v.wins === 1 ? '' : 's'} to ${v.losses}.`
                : `${first} finished ahead ${v.losses} time${v.losses === 1 ? '' : 's'} to your ${v.wins}.`}
          </div>
        </>
      ),
    });
  }

  const bits = [
    steps.value > 0 ? `${compactNumber(steps.value)} steps` : null,
    total('workouts').value > 0 ? `${amount(total('workouts'))} workouts` : null,
    r.challenges.won > 0
      ? `${r.challenges.won} challenge win${r.challenges.won === 1 ? '' : 's'}`
      : null,
  ].filter(Boolean);
  cards.push({
    key: 'end',
    tone: 'lime',
    body: (
      <>
        <div className="story-kicker">That was</div>
        <div className="story-title">{r.label}</div>
        {bits.length > 0 && <div className="story-line">{bits.join(' · ')}</div>}
        <div className="story-sub">
          {r.bestDay ? `Best day: ${longDay(r.bestDay.date)}. ` : ''}See you out there.
        </div>
        <div className="story-actions">
          <button className="btn dark" onClick={onShare}>
            <Icon name="share" size={18} /> Share
          </button>
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </>
    ),
  });
  return cards;
}

export function ReviewPage() {
  const { period = '' } = useParams();
  const parsed = parsePeriod(period);
  const q = useReview(parsed ? period : '2000-01', !!parsed);
  const { user } = useAuth();
  const badgeQ = useBadgeCatalog(user?.id ?? '', !!parsed && !!user);
  const badges = badgeQ.data?.badges;
  const navigate = useNavigate();
  const location = useLocation();
  const [index, setIndex] = useState(0);
  const touch = useRef<{ x: number; y: number } | null>(null);

  const close = useCallback(() => {
    if (location.key === 'default') navigate('/', { replace: true });
    else navigate(-1);
  }, [location.key, navigate]);

  const r = q.data;
  const share = useCallback(async () => {
    if (!r) return;
    const steps = r.totals.find((t) => t.key === 'steps');
    const text = `My ${r.label} in review on Gauntlet${steps && steps.value > 0 ? `: ${compactNumber(steps.value)} steps` : ''}.`;
    const res = await shareLink(`My ${r.label} on Gauntlet`, text, window.location.origin);
    if (res === 'copied') toast('Link copied');
    else if (res === 'failed') toast("Couldn't share. Try again.");
  }, [r]);

  const cards = useMemo(
    () =>
      r && (r.hasData || r.challenges.played > 0)
        ? buildCards(r, badges ?? [], () => void share(), close)
        : [],
    [r, badges, share, close],
  );
  const last = cards.length - 1;
  const next = useCallback(() => setIndex((i) => Math.min(i + 1, last)), [last]);
  const back = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') back();
      else if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, back, close]);

  if (!parsed) return <Navigate to="/" replace />;
  const card = cards[Math.min(index, Math.max(last, 0))];

  return (
    <div
      className="story"
      role="dialog"
      aria-modal="true"
      aria-label={`${parsed.label} in review`}
      onTouchStart={(e) => {
        const t = e.touches[0]!;
        touch.current = { x: t.clientX, y: t.clientY };
      }}
      onTouchEnd={(e) => {
        const s = touch.current;
        touch.current = null;
        const t = e.changedTouches[0];
        if (!s || !t) return;
        const dx = t.clientX - s.x;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(t.clientY - s.y) * 1.5) {
          if (dx < 0) next();
          else back();
        }
      }}
    >
      <div className="story-bars" aria-hidden>
        {cards.map((c, i) => (
          <i key={c.key} className={i <= index ? 'done' : ''} />
        ))}
      </div>
      <div className="story-top">
        <span aria-live="polite">
          {cards.length > 0 && (
            <span className="sr-only">
              Card {index + 1} of {cards.length}
            </span>
          )}
          {parsed.label}
        </span>
        <button className="story-close" onClick={close}>
          <Icon name="close" size={16} /> Close
        </button>
      </div>
      {q.isPending ? (
        <div style={{ padding: 24 }}>
          <Skeleton height={300} />
        </div>
      ) : q.error ? (
        <div style={{ padding: 24 }}>
          <ErrorBox error={q.error} />
        </div>
      ) : cards.length === 0 ? (
        <div className="story-card">
          <div className="story-kicker">{parsed.label}</div>
          <div className="story-title">A quiet {parsed.kind}</div>
          <div className="story-sub">Nothing was recorded then, so there is no story to tell.</div>
        </div>
      ) : (
        card && (
          <div className="story-stage">
            <div key={card.key} className={`story-card ${card.tone}`} data-testid="story-card">
              {card.body}
            </div>
            <button
              className="story-tap prev"
              aria-label="Previous card"
              onClick={back}
              disabled={index === 0}
            />
            <button
              className="story-tap next"
              aria-label="Next card"
              onClick={next}
              disabled={index === last}
            />
          </div>
        )
      )}
    </div>
  );
}
