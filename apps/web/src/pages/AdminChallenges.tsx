/**
 * Admin → Challenges: every challenge on this server (running, upcoming, finished). Tap one to open
 * it read-only, even a private one. Server admins only (see App.tsx).
 */
import type { AdminChallengeRow, AdminChallengeStatus } from '@gauntlet/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Empty, ErrorBox, Header, Screen, Skeleton } from '../components/ui';
import { useAdminChallenges } from '../lib/adminUsers';
import { dateRange } from '../lib/format';
import '../styles/admin.css';
import '../styles/adminUsers.css';

const TABS: { value: AdminChallengeStatus; label: string }[] = [
  { value: 'running', label: 'Running' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'finished', label: 'Finished' },
  { value: 'all', label: 'All' },
];

export function AdminChallengesPage() {
  const [status, setStatus] = useState<AdminChallengeStatus>('running');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const list = useAdminChallenges(status, q);
  const data = list.data;
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  return (
    <Screen tabs={false}>
      <Header title="Challenges" back="/admin" />
      <label className="input au-search">
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search name or creator"
          aria-label="Search challenges"
          autoComplete="off"
        />
      </label>
      <div className="au-chips" role="group" aria-label="Filter challenges">
        {TABS.map((t) => (
          <button
            key={t.value}
            className="au-chip"
            aria-pressed={status === t.value}
            onClick={() => setStatus(t.value)}
          >
            {t.label}
            {data ? <b>{data.counts[t.value]}</b> : null}
          </button>
        ))}
      </div>
      <ErrorBox error={list.error} />
      {!data ? (
        <Skeleton height={200} />
      ) : data.challenges.length === 0 ? (
        <div className="list">
          <Empty title="No challenges here">Nothing matches this filter.</Empty>
        </div>
      ) : (
        <div className="list" data-testid="admin-challenge-list">
          {data.challenges.map((c) => (
            <Row key={c.id} c={c} />
          ))}
        </div>
      )}
      <p className="au-help" style={{ marginTop: 14 }}>
        Opening a challenge shows it as read-only, even a private one. You can feature a public one
        from its page.
      </p>
    </Screen>
  );
}

function Row({ c }: { c: AdminChallengeRow }) {
  const flags = [
    c.visibility === 'public' ? 'Public' : 'Private',
    c.featured ? 'Featured' : null,
    c.solo ? 'Solo' : null,
    c.team ? 'Teams' : null,
    c.recurring ? 'Repeats' : null,
  ].filter(Boolean);
  return (
    <Link to={`/c/${c.id}`} className="item au-row" aria-label={`Open ${c.name}`}>
      <div className="grow">
        <div className="t" style={{ overflowWrap: 'anywhere' }}>
          {c.name}
        </div>
        <small>
          {c.metricLabel} · {dateRange(c.startDate, c.endDate)}
        </small>
        <small style={{ display: 'block' }}>
          by {c.creator?.displayName ?? 'someone'} · {c.joined} in
          {c.invited ? `, ${c.invited} invited` : ''}
          {c.leader ? ` · ${c.leader.displayName} leads` : ''}
        </small>
        <div className="au-tags">
          {flags.map((f) => (
            <span key={f} className={`pill ${f === 'Featured' ? '' : 'plain'}`}>
              {f}
            </span>
          ))}
        </div>
      </div>
    </Link>
  );
}
