import { isWeekId, ordinal, type RecapTotal } from '@gauntlet/shared';
import { Link, Navigate, useParams } from 'react-router';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Header, Screen, Skeleton } from '../components/ui';
import { dateRange } from '../lib/format';
import { useRecap } from '../lib/notifyQueries';
import '../styles/notify.css';

const amount = (t: RecapTotal) =>
  t.value.toLocaleString('en-US', {
    minimumFractionDigits: t.decimals,
    maximumFractionDigits: t.decimals,
  });

function Change({ t }: { t: RecapTotal }) {
  if (t.changePct == null) return <small className="recap-change flat">New this week</small>;
  if (t.changePct === 0) return <small className="recap-change flat">Same as before</small>;
  const up = t.changePct > 0;
  return (
    <small className={`recap-change ${up ? 'up' : 'down'}`}>
      {up ? '▲' : '▼'} {Math.abs(t.changePct)}% vs the week before
    </small>
  );
}

export function RecapPage() {
  const { week = '' } = useParams();
  const valid = isWeekId(week);
  const q = useRecap(valid ? week : '2000-W01');
  if (!valid) return <Navigate to="/trends" replace />;
  const r = q.data;
  const steps = r?.totals.find((t) => t.key === 'steps');
  const others = r?.totals.filter((t) => t.key !== 'steps' && t.value > 0) ?? [];
  const dayName = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });

  return (
    <Screen tabs={false}>
      <Header title="Your week" back="/trends" />
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Skeleton height={260} />
      ) : r && !r.hasData ? (
        <div className="list">
          <Empty title="A quiet week">
            Nothing was recorded for {dateRange(r.start, r.end)}. Next week, then.
          </Empty>
        </div>
      ) : r ? (
        <div className="recap" aria-label="Weekly recap">
          <div className="recap-hero">
            <small>{dateRange(r.start, r.end)}</small>
            <b className="num">{steps ? amount(steps) : '0'}</b>
            <span>steps</span>
            {steps && <Change t={steps} />}
          </div>

          {others.length > 0 && (
            <div className="recap-grid">
              {others.map((t) => (
                <div key={t.key} className="recap-tile">
                  <small>{t.label}</small>
                  <b className="num">
                    {amount(t)}
                    {t.unit && <span> {t.unit}</span>}
                  </b>
                  <Change t={t} />
                </div>
              ))}
            </div>
          )}

          {r.bestDay && (
            <div className="recap-row">
              <Icon name="flame" size={20} />
              <div className="grow">
                <small>Best day</small>
                <b>{dayName(r.bestDay.date)}</b>
              </div>
              <b className="num">{Math.round(r.bestDay.steps).toLocaleString('en-US')}</b>
            </div>
          )}

          {r.records.length > 0 && (
            <>
              <div className="lbl">Personal records</div>
              <div className="list">
                {r.records.map((text, i) => (
                  <div key={i} className="item" style={{ minHeight: 48 }}>
                    <Icon name="flame" size={18} />
                    <span className="grow t">{text}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {r.finished.length > 0 && (
            <>
              <div className="lbl">Challenges finished</div>
              <div className="list">
                {r.finished.map((c) => (
                  <Link key={c.challengeId} to={`/c/${c.challengeId}/result`} className="item">
                    <span className="grow t">{c.name}</span>
                    <span className="v num">
                      {ordinal(c.rank)}
                      <small style={{ display: 'inline', marginLeft: 4 }}>of {c.of}</small>
                    </span>
                    <Icon name="chevron" size={18} />
                  </Link>
                ))}
              </div>
            </>
          )}

          {r.standings.length > 0 && (
            <>
              <div className="lbl">Where you stand now</div>
              <div className="list">
                {r.standings.map((c) => (
                  <Link key={c.challengeId} to={`/c/${c.challengeId}`} className="item">
                    <span className="grow t">{c.name}</span>
                    <span className="v num">
                      {ordinal(c.rank)}
                      <small style={{ display: 'inline', marginLeft: 4 }}>of {c.of}</small>
                    </span>
                    <Icon name="chevron" size={18} />
                  </Link>
                ))}
              </div>
            </>
          )}
        </div>
      ) : null}
    </Screen>
  );
}
