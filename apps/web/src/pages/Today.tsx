import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { ChallengeHero, FeedList } from '../components/Feed';
import { Icon } from '../components/Icon';
import { Rings } from '../components/Rings';
import { Avatar, Empty, ErrorBox, Screen, Skeleton } from '../components/ui';
import { post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtInt, timeAgo } from '../lib/format';
import { useFeed, useToday } from '../lib/queries';

export function TodayPage() {
  const { user } = useAuth();
  const today = useToday();
  const feed = useFeed();
  const qc = useQueryClient();
  const [syncing, setSyncing] = useState(false);

  async function refresh() {
    setSyncing(true);
    try {
      await post('/api/me/sync');
      await qc.invalidateQueries();
    } finally {
      setSyncing(false);
    }
  }

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
        {today.data?.featured ? (
          <ChallengeHero c={today.data.featured} />
        ) : today.isSuccess ? (
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

      <div className="lbl">
        <span>Recent from your crew</span>
        <button
          onClick={refresh}
          disabled={syncing}
          aria-label="Sync now"
          className="row"
          style={{ gap: 4 }}
        >
          {syncing ? 'Syncing…' : `Synced ${timeAgo(today.data?.lastSyncedAt)}`}
        </button>
      </div>
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
              <Link to="/friends" className="btn secondary sm" style={{ display: 'inline-flex' }}>
                Find friends
              </Link>
            </div>
          </Empty>
        </div>
      )}
    </Screen>
  );
}
