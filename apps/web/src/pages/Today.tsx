import { Link } from 'react-router';
import { ChallengeHero, FeedList } from '../components/Feed';
import { Icon } from '../components/Icon';
import { Rings } from '../components/Rings';
import { Avatar, Empty, ErrorBox, Screen, Skeleton } from '../components/ui';
import { useAuth } from '../lib/auth';
import { useSyncNow } from '../lib/freshness';
import { isNative } from '../lib/platform';
import { fmtInt, timeAgo } from '../lib/format';
import { useChallenges, useFeed, useToday } from '../lib/queries';
import { FastCard } from '../components/FastCard';

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
  const { busy: syncing, sync } = useSyncNow();

  const m = today.data?.metrics ?? [];
  const ring = (k: string) => {
    const x = m.find((v) => v.key === k);
    return x?.value && x.goal ? x.value / x.goal : 0;
  };
  const legend = [
    { k: 'steps', label: 'Steps', color: 'var(--volt)' },
    { k: 'active_calories', label: 'Active kcal', color: 'var(--text)' },
    { k: 'active_minutes', label: 'Active min', color: 'var(--muted)' },
  ];

  return (
    <Screen>
      <div className="hd">
        <h1>Today</h1>
        <Link to="/me" aria-label="Profile">
          {user && <Avatar user={user} size={36} me />}
        </Link>
      </div>
      <ErrorBox error={today.error} />
      {today.data && !today.data.hasSources && <ConnectSourceHero />}
      {today.isPending ? (
        <Skeleton height={142} />
      ) : (
        <div className="card row" style={{ gap: 16 }}>
          <Rings values={[ring('steps'), ring('active_calories'), ring('active_minutes')]} />
          <div className="grow stack" style={{ gap: 8 }}>
            {legend.map((l) => (
              <div key={l.k} className="row" style={{ gap: 8, fontSize: 13 }}>
                <i style={{ width: 10, height: 10, borderRadius: '50%', background: l.color }} />
                <span className="muted grow">{l.label}</span>
                <b className="num" style={{ fontSize: 15 }}>
                  {fmtInt(m.find((v) => v.key === l.k)?.value)}
                </b>
              </div>
            ))}
          </div>
        </div>
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
                    ? x.value.toFixed(1)
                    : fmtInt(x.value)}
                {x.unit && x.value != null ? ` ${x.unit}` : ''}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <>
          <ErrorBox error={feed.error} />
          {feed.isPending ? (
            <Skeleton height={180} />
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
