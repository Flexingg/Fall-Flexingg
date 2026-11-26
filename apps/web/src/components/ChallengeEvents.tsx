import { addDays, eventKindsFor, minDate, todayIn, type ChallengeDetail } from '@gauntlet/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { workoutPath } from '../lib/statsQueries';
import { dateRange } from '../lib/format';
import { useEvents } from '../lib/queries';
import { shortName } from '../lib/format';
import { Icon } from './Icon';
import { Avatar, Empty, ErrorBox, Skeleton } from './ui';

const ICON = { workout: 'dumbbell', lift: 'dumbbell', fast: 'hourglass', day: 'target' } as const;

/**
 * "What counted": the workouts, lift sessions and fasts behind each score for one day, read live
 * from each person's SparkyFitness. Only shown to people in the challenge, and only for challenges
 * that turned Show Events on.
 */
export function ChallengeEvents({ c }: { c: ChallengeDetail }) {
  const today = todayIn(c.timezone);
  const last = minDate(c.endDate, today);
  const [date, setDate] = useState(last < c.startDate ? c.startDate : last);
  const [who, setWho] = useState<string | null>(null);
  const covered = c.status !== 'upcoming';
  const q = useEvents(c.id, date, who, covered);
  const noEvents = eventKindsFor(c.metric).length === 0;

  return (
    <section aria-label="What counted">
      <div className="lbl">What counted</div>
      {noEvents ? (
        <div className="notice">Weight stays private, so no weigh-ins are listed.</div>
      ) : !covered ? (
        <div className="notice">Events appear once the challenge starts.</div>
      ) : (
        <>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <button
              className="btn sm secondary"
              style={{ width: 'auto' }}
              aria-label="Previous day"
              disabled={date <= c.startDate}
              onClick={() => setDate(addDays(date, -1))}
            >
              <Icon name="back" size={14} />
            </button>
            <b>{dateRange(date, date)}</b>
            <button
              className="btn sm secondary"
              style={{ width: 'auto' }}
              aria-label="Next day"
              disabled={date >= last}
              onClick={() => setDate(addDays(date, 1))}
            >
              <Icon name="chevron" size={14} />
            </button>
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            <Seg2 on={who === null} onClick={() => setWho(null)}>
              Everyone
            </Seg2>
            {c.standings.map((s) => (
              <Seg2 key={s.user.id} on={who === s.user.id} onClick={() => setWho(s.user.id)}>
                {s.isMe ? 'You' : shortName(s.user.displayName).split(' ')[0]}
              </Seg2>
            ))}
          </div>
          <ErrorBox error={q.error} />
          {q.isPending && <Skeleton height={120} />}
          {q.data && (
            <div className="list" style={{ opacity: q.isFetching ? 0.6 : 1 }}>
              {q.data.groups.map((g) => (
                <div key={g.user.id}>
                  <div className="item" style={{ minHeight: 44 }}>
                    <Avatar user={g.user} size={28} me={g.isMe} />
                    <div className="t grow">{g.isMe ? 'You' : shortName(g.user.displayName)}</div>
                    {g.status === 'hidden' && (
                      <small className="muted">Keeps workouts private</small>
                    )}
                    {g.status === 'unavailable' && (
                      <small className="muted">SparkyFitness couldn't be reached</small>
                    )}
                    {g.status === 'ok' && g.events.length === 0 && (
                      <small className="muted">Nothing counted</small>
                    )}
                  </div>
                  {g.events.map((e) => {
                    const body = (
                      <>
                        <Icon name={ICON[e.kind]} size={18} />
                        <div className="grow">
                          <div className="t">{e.title}</div>
                          <small>{e.detail}</small>
                        </div>
                        {e.source && <span className="pill plain">{e.source}</span>}
                        {e.workoutId && <Icon name="chevron" size={14} />}
                      </>
                    );
                    // Workouts and lift sessions open their detail (yours, or theirs via Show Events).
                    return e.workoutId ? (
                      <Link
                        key={e.id}
                        to={workoutPath(e.workoutId, g.isMe ? null : g.user.id)}
                        className="item"
                        style={{ paddingLeft: 52 }}
                      >
                        {body}
                      </Link>
                    ) : (
                      <div key={e.id} className="item" style={{ paddingLeft: 52 }}>
                        {body}
                      </div>
                    );
                  })}
                </div>
              ))}
              {q.data.more > 0 && (
                <Empty title={`${q.data.more} more`}>Pick a name above to see theirs.</Empty>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Seg2({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`pill${on ? '' : ' plain'}`}
      aria-pressed={on}
      onClick={onClick}
      style={{ cursor: 'pointer' }}
    >
      {children}
    </button>
  );
}
