import { Link } from 'react-router';
import { ChallengeHero, FeedList } from '../components/Feed';
import { Icon } from '../components/Icon';
import { RingCard } from '../components/RingCard';
import { LevelPill } from '../components/TodayBadges';
import { Avatar, Empty, ErrorBox, Screen } from '../components/ui';
import { SkeletonCard, SkeletonLine, SkeletonList } from '../components/Skeleton';
import { useAuth } from '../lib/auth';
import { useSyncNow } from '../lib/freshness';
import { isNative } from '../lib/platform';
import { fmtInt, fmtQty, timeAgo, unitLabel } from '../lib/format';
import { useChallenges, useFeed, useToday } from '../lib/queries';
import { useUnreadCount } from '../lib/notifyQueries';
import { useReviewList } from '../lib/reviewQueries';
import { monthName, reviewsToOffer, ringsOfToday, todayIn } from '@gauntlet/shared';
import '../styles/notify.css';
import { FastCard } from '../components/FastCard';
import { LimitedBadges } from '../components/LimitedBadges';

const FASTING = new Set<string>(['fast_hours', 'fasts_completed']);

export function TodayPage() {
  const { user, mode } = useAuth();
  const direct = mode === 'direct';
  const today = useToday();
  const feed = useFeed();
  const challenges = useChallenges(!direct);
  const inFastingChallenge =
    !direct &&
    !!challenges.data?.some(
      (c) => c.status === 'active' && c.myState === 'joined' && FASTING.has(c.metric),
    );
  const unread = useUnreadCount(!direct);
  const unreadCount = unread.data?.count ?? 0;
  const { busy: syncing, sync } = useSyncNow();

  const m = today.data?.metrics ?? [];
  return (
    <Screen>
      <div className="hd">
        <h1>Today</h1>
        <div className="hd-actions">
          {!direct && (
            <Link
              to="/notifications"
              className="bell-btn"
              aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : 'Notifications'}
            >
              <Icon name="bell" size={20} />
              {unreadCount > 0 && (
                <span className="bell-badge" data-testid="bell-count">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </Link>
          )}
          {!direct && <LevelPill />}
          <Link to="/me" aria-label="Profile">
            {user && <Avatar user={user} size={36} me />}
          </Link>
        </div>
      </div>
      <ErrorBox error={today.error} />
      {today.data && !today.data.hasSources && <ConnectSourceHero />}
      {today.isPending ? (
        <SkeletonCard>
          <div className="row" style={{ gap: 16 }}>
            <SkeletonLine width={110} height={110} style={{ borderRadius: '50%' }} />
            <div className="grow stack" style={{ gap: 14 }}>
              <SkeletonLine />
              <SkeletonLine />
              <SkeletonLine />
            </div>
          </div>
        </SkeletonCard>
      ) : (
        today.data && <RingCard rings={ringsOfToday(today.data)} />
      )}

      <div style={{ marginTop: 12 }}>
        {direct ? (
          <Link to="/challenges" className="hero">
            <div className="badge">
              <Icon name="trophy" />
            </div>
            <div className="grow">
              <small>Friends &amp; challenges</small>
              <b>Connect a Gauntlet server</b>
            </div>
          </Link>
        ) : today.data?.featured ? (
          <ChallengeHero c={today.data.featured} />
        ) : today.isSuccess && today.data.hasSources ? (
          <Link to="/c/new" className="hero">
            <div className="badge">
              <Icon name="plus" />
            </div>
            <div className="grow">
              <small>No active challenge</small>
              <b>Throw down the gauntlet</b>
            </div>
          </Link>
        ) : null}
      </div>

      {!direct && <ReviewCards />}

      {!direct && <LimitedBadges />}

      {inFastingChallenge && <FastCard />}

      <div className="lbl">
        <span>{direct ? 'Today' : 'Recent from your crew'}</span>
        <button
          onClick={() => void sync()}
          disabled={syncing}
          aria-label="Sync now"
          className="row sync-btn"
          style={{ gap: 5 }}
        >
          <Icon name="refresh" size={14} className={syncing ? 'spin' : undefined} />
          {syncing ? 'Syncing…' : `Synced ${timeAgo(today.data?.lastSyncedAt)}`}
        </button>
      </div>
      {direct ? (
        <div className="list">
          {m.map((x) => (
            <div key={x.key} className="item" style={{ minHeight: 52 }}>
              <span className="grow t">{x.label}</span>
              <span className="v num">
                {x.value == null
                  ? '–'
                  : x.key === 'distance'
                    ? fmtQty(x.value, x.unit, 1, false)
                    : fmtInt(x.value)}
                {x.unit && x.value != null ? ` ${unitLabel(x.unit)}` : ''}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <>
          <ErrorBox error={feed.error} />
          {feed.isPending ? (
            <SkeletonList rows={3} />
          ) : feed.data?.length ? (
            <FeedList events={feed.data} />
          ) : (
            <div className="list">
              <Empty title="Quiet in here">
                Add friends and start a challenge. Their workouts show up here.
                <div style={{ marginTop: 14 }}>
                  <Link
                    to="/friends"
                    className="btn secondary sm"
                    style={{ display: 'inline-flex' }}
                  >
                    Find friends
                  </Link>
                </div>
              </Empty>
            </div>
          )}
        </>
      )}
    </Screen>
  );
}

/** "Your October in review" in a month's first week, "Your 2026 in review" from 1 Dec to 7 Jan. */
function ReviewCards() {
  const { user } = useAuth();
  const list = useReviewList(!!user);
  if (!user || !list.data) return null;
  const offer = reviewsToOffer(todayIn(user.timezone));
  const cards = [
    offer.month && list.data.months.includes(offer.month)
      ? {
          to: offer.month,
          kicker: 'Month in review',
          title: `Your ${monthName(Number(offer.month.slice(5)))} in review`,
        }
      : null,
    offer.year && list.data.years.includes(offer.year)
      ? { to: offer.year, kicker: 'Year in review', title: `Your ${offer.year} in review` }
      : null,
  ].filter((c): c is { to: string; kicker: string; title: string } => c !== null);
  return (
    <>
      {cards.map((c) => (
        <Link
          key={c.to}
          to={`/review/${c.to}`}
          className="hero review-card"
          style={{ marginTop: 12 }}
        >
          <div className="badge">
            <Icon name="trends" />
          </div>
          <div className="grow">
            <small>{c.kicker}</small>
            <b>{c.title}</b>
          </div>
          <Icon name="chevron" size={18} />
        </Link>
      ))}
    </>
  );
}

/** New accounts have nothing feeding them yet: point them at the quickest ways to fix that. */
function ConnectSourceHero() {
  const quick = [
    ...(isNative ? [{ label: 'Health Connect', to: '/sources#health-connect' }] : []),
    { label: 'Garmin', to: '/sources#garmin' },
    { label: 'Strava', to: '/sources#strava' },
    { label: 'More apps', to: '/sources' },
  ];
  return (
    <div className="hero stack" style={{ alignItems: 'stretch', marginBottom: 12 }}>
      <Link to="/sources" className="row" style={{ gap: 14 }}>
        <div className="badge">
          <Icon name="link" />
        </div>
        <div className="grow">
          <small>No data coming in yet</small>
          <b>Connect your first data source</b>
        </div>
      </Link>
      <p style={{ fontSize: 13, lineHeight: 1.45, opacity: 0.85 }}>
        Gauntlet scores what your watch, phone or fitness app records. Link one and your steps,
        workouts and more show up here within minutes.
      </p>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        {quick.map((q) => (
          <Link key={q.label} to={q.to} className="chip-dark">
            {q.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
