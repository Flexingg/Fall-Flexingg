import type { ChallengeSummary } from '@gauntlet/shared';
import { ordinal } from '@gauntlet/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Header, Screen, Seg, Skeleton } from '../components/ui';
import { daysLeftText, fmt } from '../lib/format';
import { useChallenges } from '../lib/queries';

export function ChallengesPage() {
  const q = useChallenges();
  const [tab, setTab] = useState<'live' | 'done'>('live');
  const list = (q.data ?? []).filter((c) => (tab === 'live' ? c.status !== 'completed' : c.status === 'completed'));
  const invites = list.filter((c) => c.myState === 'invited');
  const mine = list.filter((c) => c.myState === 'joined');

  return (
    <Screen>
      <Header
        title="Challenges"
        action={
          <Link to="/c/new" className="av lead" style={{ width: 36, height: 36 }} aria-label="New challenge">
            <Icon name="plus" size={20} strokeWidth={2.5} />
          </Link>
        }
      />
      <Seg label="Show" value={tab} onChange={setTab} options={[{ value: 'live', label: 'Active & upcoming' }, { value: 'done', label: 'Finished' }]} />
      <div style={{ height: 14 }} />
      <ErrorBox error={q.error} />
      {q.isPending && <Skeleton height={200} />}
      {invites.length > 0 && (
        <>
          <div className="lbl" style={{ marginTop: 0 }}>Invites</div>
          <ChallengeList items={invites} />
        </>
      )}
      {mine.length > 0 && (
        <>
          {invites.length > 0 && <div className="lbl">Yours</div>}
          <ChallengeList items={mine} />
        </>
      )}
      {q.isSuccess && list.length === 0 && (
        <div className="list">
          <Empty title={tab === 'live' ? 'No challenges yet' : 'Nothing finished yet'}>
            {tab === 'live' && (
              <>
                Pick a metric, set the stakes, invite your crew.
                <div style={{ marginTop: 14 }}>
                  <Link to="/c/new" className="btn sm" style={{ display: 'inline-flex' }}>
                    New challenge
                  </Link>
                </div>
              </>
            )}
          </Empty>
        </div>
      )}
    </Screen>
  );
}

function ChallengeList({ items }: { items: ChallengeSummary[] }) {
  return (
    <div className="list">
      {items.map((c) => (
        <Link key={c.id} to={c.status === 'completed' ? `/c/${c.id}/result` : `/c/${c.id}`} className="item">
          <div className="grow">
            <div className="t ellipsis">{c.name}</div>
            <small>
              {c.metricLabel} · {c.participantCount} {c.participantCount === 1 ? 'person' : 'people'} · {daysLeftText(c)}
            </small>
          </div>
          {c.myState === 'invited' ? (
            <span className="pill">Invited</span>
          ) : (
            <>
              <span className="v num">{fmt(c.myScore, c)}</span>
              {c.myRank && <span className={`pill${c.myRank === 1 ? '' : ' plain'}`}>{ordinal(c.myRank)}</span>}
            </>
          )}
        </Link>
      ))}
    </div>
  );
}
