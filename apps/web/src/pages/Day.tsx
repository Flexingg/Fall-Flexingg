/**
 * Every stat for a day, opened by tapping the Today rings: the three rings big at the top, then
 * activity, sleep and heart, food and water, strength, fasting, body and other measurements, each
 * against the person's own goal where there is one. Page back through earlier days; "Edit rings"
 * changes which stats the rings show and their goals.
 */
import {
  addDays,
  earliestDay,
  formatQuantityFlexible,
  todayIn,
  type DayStat,
} from '@gauntlet/shared';
import { useSearchParams } from 'react-router';
import { Link } from 'react-router';
import { Icon } from '../components/Icon';
import { RingLegend, ringValues } from '../components/RingCard';
import { Rings } from '../components/Rings';
import { SkeletonCard } from '../components/Skeleton';
import { Empty, ErrorBox, Header, Screen } from '../components/ui';
import { useAuth } from '../lib/auth';
import { useDisplay } from '../lib/display';
import { fmtDate } from '../lib/format';
import { useDay } from '../lib/ringQueries';
import '../styles/rings.css';

function StatRow({ s }: { s: DayStat }) {
  const display = useDisplay();
  const value = formatQuantityFlexible(s.value, s.unit, s.decimals, display);
  const goal = s.goal ? formatQuantityFlexible(s.goal, s.unit, s.decimals, display) : null;
  const pct = s.goal ? Math.min(100, (s.value / s.goal) * 100) : null;
  return (
    <div className="stat-item" data-testid="day-stat">
      <span className="t">{s.label}</span>
      <span className="v num">
        {value}
        {goal && <small>of {goal}</small>}
      </span>
      {pct != null && (
        <div className="stat-bar" aria-hidden>
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

export function DayPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const today = todayIn(user?.timezone ?? 'UTC');
  const asked = params.get('date') ?? '';
  const date = asked && asked < today ? asked : '';
  const q = useDay(date);
  const shown = date || today;
  const go = (d: string) => setParams(d >= today ? {} : { date: d }, { replace: true });
  const title = shown === today ? 'Today' : shown === addDays(today, -1) ? 'Yesterday' : null;
  const d = q.data;
  return (
    <Screen>
      <Header title="Day stats" back="/" />
      <div className="day-nav">
        <button
          aria-label="Previous day"
          disabled={shown <= earliestDay(today)}
          onClick={() => go(addDays(shown, -1))}
        >
          <Icon name="back" size={18} />
        </button>
        <div className="when" data-testid="day-when">
          {title ?? fmtDate(shown, { weekday: 'long' })}
          <small>{fmtDate(shown, { month: 'long', day: 'numeric', year: 'numeric' })}</small>
        </div>
        <button
          aria-label="Next day"
          disabled={shown >= today}
          onClick={() => go(addDays(shown, 1))}
          style={{ transform: 'scaleX(-1)' }}
        >
          <Icon name="back" size={18} />
        </button>
      </div>
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <SkeletonCard>
          <div style={{ height: 240 }} />
        </SkeletonCard>
      ) : d ? (
        <>
          <div className="card day-rings">
            <Rings values={ringValues(d.rings)} size={160} />
            <RingLegend rings={d.rings} />
            <Link to="/day/rings" className="btn secondary day-edit">
              Edit rings
            </Link>
          </div>
          {d.sections.length === 0 && (
            <div className="list" style={{ marginTop: 16 }}>
              <Empty title="Nothing recorded yet">
                {shown === today
                  ? 'Stats show up here as your sources sync.'
                  : 'No stats were recorded for this day.'}
              </Empty>
            </div>
          )}
          {d.sections.map((sec) => (
            <section key={sec.key}>
              <div className="lbl">{sec.label}</div>
              <div className="list">
                {sec.stats.map((s) => (
                  <StatRow key={s.key} s={s} />
                ))}
              </div>
            </section>
          ))}
        </>
      ) : null}
    </Screen>
  );
}
