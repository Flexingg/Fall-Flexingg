import {
  BUILTIN_METRICS,
  METRIC_GROUPS,
  toDisplayUnit,
  trendDef,
  type TrendDefInfo,
  type TrendsResponse,
  type TrendOverviewItem,
} from '@gauntlet/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { BarChart } from '../components/BarChart';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Header, Screen, Seg } from '../components/ui';
import { SkeletonChart, SkeletonGroup, SkeletonList } from '../components/Skeleton';
import { useDisplay } from '../lib/display';
import { fmtDate, fmtNum } from '../lib/format';
import { useTrends, useTrendsOverview } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { useWorkouts, workoutPath } from '../lib/statsQueries';
import '../styles/stats.css';
import { previousIsoWeek, todayIn } from '@gauntlet/shared';
import { timezone } from '../lib/platform';

export function TrendsPage() {
  const { mode, user } = useAuth();
  const [range, setRange] = useState<'day' | 'week' | 'month'>('week');
  const [metric, setMetric] = useState<string>('steps');
  const q = useTrends(range, metric);
  const overview = useTrendsOverview(range);
  const { units } = useDisplay();
  const base: TrendDefInfo = q.data?.def ?? trendDef(metric) ?? trendDef('steps')!;
  // Values arrive in metric; show them in the person's units (km -> mi, kg -> lb).
  const shown = toDisplayUnit(1, base.unit, base.decimals, units);
  const def: TrendDefInfo = { ...base, unit: shown.unit, decimals: shown.decimals };
  const t = q.data && shown.value !== 1 ? scaleTrends(q.data, shown.value) : q.data;
  // The day picked on the chart, if any; switching stat or range lets go.
  const [picked, setPicked] = useState<string | null>(null);
  // Compare lays the period before over each bar; remembered between visits.
  const [compare, setCompare] = useState(readCompare);
  const ghost = compare && t?.previousBars ? t.previousBars.map((b) => b.value) : undefined;
  const pickedIdx = t ? t.bars.findIndex((b) => b.date === picked) : -1;
  useEffect(() => setPicked(null), [metric, range]);
  const pickedBar = t?.bars.find((b) => b.date === picked) ?? null;
  // Days after today in "this week/month" have no data yet; don't show them as a real zero.
  const todayDate = t?.bars.find((b) => b.isToday)?.date ?? null;
  const upcoming = (d: string) => todayDate != null && d > todayDate;
  const num = (v: number) => fmtNum(v, def.decimals);
  const unit = def.unit ?? '';
  // Every stat a challenge can use, then whatever else the person has data for (each exercise,
  // custom measurements, weight).
  const options = new Map<string, { key: string; label: string; group: TrendDefInfo['group'] }>();
  for (const k of BUILTIN_METRICS) {
    const d = trendDef(k);
    if (d) options.set(k, d);
  }
  for (const a of overview.data?.available ?? []) options.set(a.key, a);
  if (!options.has(metric))
    options.set(metric, { key: metric, label: def.label, group: def.group });
  const prevName =
    range === 'week' ? 'last week' : range === 'month' ? 'the 30 days before' : 'the week before';
  const legend =
    range === 'week'
      ? ['This week', 'Last week']
      : range === 'month'
        ? ['Last 30 days', 'The 30 days before']
        : ['Last 7 days', 'The week before'];
  const showWorkouts = (metric === 'workouts' || metric === 'lift_volume') && mode !== 'direct';
  const workouts = useWorkouts(showWorkouts);
  const rangeName =
    range === 'week' ? 'this week' : range === 'month' ? 'last 30 days' : 'last 7 days';

  return (
    <Screen>
      <Header
        title="Trends"
        action={
          mode !== 'direct' && (
            <Link
              to={`/recap/${previousIsoWeek(todayIn(user?.timezone ?? timezone))}`}
              className="btn secondary sm"
            >
              Last week
            </Link>
          )
        }
      />
      <Seg
        label="Range"
        value={range}
        onChange={setRange}
        options={[
          { value: 'day', label: '7 days' },
          { value: 'week', label: 'Week' },
          { value: 'month', label: 'Month' },
        ]}
      />
      <div style={{ height: 12 }} />
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <SkeletonGroup>
          <SkeletonChart height={150} />
          <SkeletonList rows={3} avatar={null} />
        </SkeletonGroup>
      ) : (
        t && (
          <div className="card">
            <label className="lbl" style={{ margin: 0 }}>
              <select
                value={metric}
                onChange={(e) => setMetric(e.target.value)}
                aria-label="Metric"
                style={{
                  background: 'none',
                  border: 0,
                  color: 'var(--muted)',
                  font: 'inherit',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  fontWeight: 700,
                }}
              >
                {METRIC_GROUPS.map((g) => {
                  const list = [...options.values()].filter((o) => o.group === g.key);
                  return list.length ? (
                    <optgroup key={g.key} label={g.label} style={{ background: 'var(--card)' }}>
                      {list.map((o) => (
                        <option key={o.key} value={o.key} style={{ background: 'var(--card)' }}>
                          {o.label} {rangeName}
                        </option>
                      ))}
                    </optgroup>
                  ) : null;
                })}
              </select>
            </label>
            {pickedBar ? (
              <div className="big num" style={{ marginTop: 6 }} aria-live="polite">
                {upcoming(pickedBar.date) ? '–' : num(pickedBar.value)}
                <small>
                  {upcoming(pickedBar.date)
                    ? `${longDay(pickedBar.date)} is still to come`
                    : `${unit ? `${unit} ` : ''}on ${longDay(pickedBar.date)}`}
                  {ghost && !upcoming(pickedBar.date) && pickedIdx >= 0
                    ? ` · ${num(ghost[pickedIdx]!)} ${prevName}${vsPct(pickedBar.value, ghost[pickedIdx]!)}`
                    : ''}
                </small>
                <button className="chart-clear" onClick={() => setPicked(null)}>
                  Show total
                </button>
              </div>
            ) : (
              <div className="big num" style={{ marginTop: 6 }}>
                {num(t.total)}
                <small>
                  {suffix(def)}
                  {t.changePct != null &&
                    ` ${t.changePct >= 0 ? '+' : ''}${fmtNum(t.changePct)}% vs last`}
                </small>
              </div>
            )}
            {t.previousBars && (
              <div className="chart-tools">
                <button
                  type="button"
                  className={`pill${compare ? '' : ' plain'}`}
                  aria-pressed={compare}
                  onClick={() => {
                    setCompare(!compare);
                    saveCompare(!compare);
                  }}
                  style={{ cursor: 'pointer', minHeight: 32, padding: '0 14px', fontSize: 13 }}
                >
                  Compare
                </button>
                {compare && (
                  <div className="chart-legend" aria-hidden="true">
                    <span>
                      <i /> {legend[0]}
                    </span>
                    <span>
                      <i className="ghost" /> {legend[1]}
                    </span>
                  </div>
                )}
              </div>
            )}
            <BarChart
              label={`${def.label} per day`}
              bars={t.bars}
              selected={picked}
              onSelect={setPicked}
              ghost={ghost}
              describe={(b) => {
                if (upcoming(b.date)) return `${longDay(b.date)}: still to come`;
                const prev = ghost?.[t.bars.indexOf(b)];
                return `${longDay(b.date)}: ${num(b.value)}${unit ? ` ${unit}` : ''}${b.isToday ? ', today' : ''}${prev != null ? `. ${prevName}: ${num(prev)}${unit ? ` ${unit}` : ''}` : ''}`;
              }}
            />
          </div>
        )
      )}

      {overview.data && overview.data.items.length > 0 && (
        <>
          <div className="lbl">All stats · {rangeName}</div>
          <div className="list" aria-label="All stats">
            {overview.data.items.map((i) => (
              <button
                key={i.key}
                className={`item${i.key === metric ? ' me' : ''}`}
                aria-pressed={i.key === metric}
                onClick={() => {
                  setMetric(i.key);
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
              >
                <div className="grow" style={{ textAlign: 'left' }}>
                  <div className="t ellipsis">{i.label}</div>
                  <small>{GROUP_LABEL.get(i.group)}</small>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="v num">{overviewValue(i, units)}</div>
                  {i.changePct != null && (
                    <small className="muted num">
                      {i.changePct >= 0 ? '+' : ''}
                      {fmtNum(i.changePct)}%
                    </small>
                  )}
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {t?.rankHistory && t.rankHistory.points.length > 0 && (
        <>
          <div className="lbl">Rank history · {t.rankHistory.name}</div>
          <div className="card">
            <RankLine points={t.rankHistory.points} />
          </div>
        </>
      )}

      {showWorkouts && workouts.data && workouts.data.workouts.length > 0 && (
        <>
          <div className="lbl">Recent workouts</div>
          <div className="list" aria-label="Recent workouts">
            {workouts.data.workouts.map((w) => (
              <Link key={w.id} to={workoutPath(w.id)} className="item">
                <div className="grow" style={{ textAlign: 'left', minWidth: 0 }}>
                  <div className="t ellipsis">{w.name}</div>
                  <small className="ellipsis">
                    {longDay(w.date)}
                    {w.source ? ` · ${w.source}` : ''} · {w.summary}
                  </small>
                </div>
                <Icon name="chevron" size={16} />
              </Link>
            ))}
          </div>
        </>
      )}

      <div className="lbl">Personal bests</div>
      {mode === 'direct' && (
        <p className="muted" style={{ fontSize: 12, margin: '-4px 0 8px' }}>
          Based on your last two months.
        </p>
      )}
      {t ? (
        <div className="pb">
          {t.personalBests.map((p) => (
            <div key={p.label}>
              <b className="num">{p.value}</b>
              <span>{p.label}</span>
            </div>
          ))}
        </div>
      ) : (
        !q.isPending && <Empty title="No data yet" />
      )}
      {t && t.total === 0 && (
        <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
          No {def.label.toLowerCase()} data {rangeName}. Connect a source under Data sources.
        </p>
      )}
    </Screen>
  );
}

const COMPARE_KEY = 'gauntlet.trends.compare';
function readCompare(): boolean {
  try {
    return localStorage.getItem(COMPARE_KEY) === '1';
  } catch {
    return false;
  }
}
function saveCompare(on: boolean) {
  try {
    localStorage.setItem(COMPARE_KEY, on ? '1' : '0');
  } catch {
    // Storage can be blocked; the toggle still works for this visit.
  }
}

/** " (+29%)" against the previous value, or nothing when there is nothing to compare with. */
function vsPct(now: number, before: number): string {
  if (!(before > 0)) return '';
  const pct = Math.round(((now - before) / before) * 100);
  return ` (${pct >= 0 ? '+' : ''}${fmtNum(pct)}%)`;
}

const GROUP_LABEL = new Map(METRIC_GROUPS.map((g) => [g.key, g.label]));

/** The same series with every value multiplied (for unit conversion). */
function scaleTrends(t: TrendsResponse, k: number): TrendsResponse {
  return {
    ...t,
    total: t.total * k,
    bars: t.bars.map((b) => ({ ...b, value: b.value * k })),
    previousBars: t.previousBars?.map((b) => ({ ...b, value: b.value * k })) ?? t.previousBars,
  };
}

/** "km", "bpm avg", "kg best" … how the headline number is combined over the range. */
function suffix(d: Pick<TrendDefInfo, 'unit' | 'aggregate'>): string {
  const word = { sum: '', avg: 'avg', max: 'best', last: 'latest' }[d.aggregate];
  return [d.unit, word].filter(Boolean).join(' ');
}

function overviewValue(i: TrendOverviewItem, units: 'metric' | 'imperial'): string {
  const q = toDisplayUnit(i.total, i.unit, i.decimals, units);
  return `${fmtNum(q.value, q.decimals)} ${suffix({ ...i, unit: q.unit })}`.trim();
}

function RankLine({ points }: { points: { date: string; rank: number }[] }) {
  const w = 320;
  const h = 70;
  const worst = Math.max(...points.map((p) => p.rank), 2);
  const xy = points.map(
    (p, i) =>
      [
        points.length === 1 ? w / 2 : 5 + (i * (w - 10)) / (points.length - 1),
        8 + ((p.rank - 1) / (worst - 1)) * (h - 16),
      ] as const,
  );
  const last = xy[xy.length - 1]!;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      height={h}
      fill="none"
      role="img"
      aria-label={`Current rank ${points[points.length - 1]!.rank}`}
    >
      <polyline
        points={xy.map(([x, y]) => `${x},${y}`).join(' ')}
        stroke="var(--volt)"
        strokeWidth={3}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={last[0]} cy={last[1]} r={5} fill="var(--volt)" />
      <text x={w - 4} y={h - 2} textAnchor="end" fill="var(--muted)" fontSize="11">
        rank {points[points.length - 1]!.rank}
      </text>
    </svg>
  );
}

const longDay = (d: string) => fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' });
