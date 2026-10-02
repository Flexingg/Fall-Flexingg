import {
  BUILTIN_METRICS,
  METRIC_GROUPS,
  trendDef,
  type TrendDefInfo,
  type TrendOverviewItem,
} from '@gauntlet/shared';
import { useState } from 'react';
import { Empty, ErrorBox, Header, Screen, Seg, Skeleton } from '../components/ui';
import { useTrends, useTrendsOverview } from '../lib/queries';
import { useAuth } from '../lib/auth';

export function TrendsPage() {
  const { mode } = useAuth();
  const [range, setRange] = useState<'day' | 'week' | 'month'>('week');
  const [metric, setMetric] = useState<string>('steps');
  const q = useTrends(range, metric);
  const overview = useTrendsOverview(range);
  const t = q.data;
  const def: TrendDefInfo = t?.def ?? trendDef(metric) ?? trendDef('steps')!;
  const max = Math.max(...(t?.bars.map((b) => b.value) ?? [0]), 1);
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
  const rangeName =
    range === 'week' ? 'this week' : range === 'month' ? 'last 30 days' : 'last 7 days';

  return (
    <Screen>
      <Header title="Trends" />
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
        <Skeleton height={210} />
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
            <div className="big num" style={{ marginTop: 6 }}>
              {def.decimals
                ? t.total.toFixed(def.decimals)
                : Math.round(t.total).toLocaleString('en-US')}
              <small>
                {suffix(def)}
                {t.changePct != null &&
                  ` ${t.changePct >= 0 ? '+' : ''}${Math.round(t.changePct)}% vs last`}
              </small>
            </div>
            <div
              className={`bars${t.bars.length > 10 ? ' dense' : ''}`}
              role="img"
              aria-label={`${def.label} per day`}
            >
              {t.bars.map((b) => (
                <div
                  key={b.date}
                  className={b.isToday ? 'today' : ''}
                  title={`${b.date}: ${b.value}`}
                >
                  <i style={{ height: `${(b.value / max) * 100}%` }} />
                  {t.bars.length <= 10 || Number(b.label) % 5 === 0 ? b.label : ''}
                </div>
              ))}
            </div>
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
                  <div className="v num">{overviewValue(i)}</div>
                  {i.changePct != null && (
                    <small className="muted num">
                      {i.changePct >= 0 ? '+' : ''}
                      {Math.round(i.changePct)}%
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

const GROUP_LABEL = new Map(METRIC_GROUPS.map((g) => [g.key, g.label]));

const fmtValue = (v: number, d: Pick<TrendDefInfo, 'decimals'>) =>
  d.decimals ? v.toFixed(d.decimals) : Math.round(v).toLocaleString('en-US');

/** "km", "bpm avg", "kg best" … how the headline number is combined over the range. */
function suffix(d: Pick<TrendDefInfo, 'unit' | 'aggregate'>): string {
  const word = { sum: '', avg: 'avg', max: 'best', last: 'latest' }[d.aggregate];
  return [d.unit, word].filter(Boolean).join(' ');
}

function overviewValue(i: TrendOverviewItem): string {
  return `${fmtValue(i.total, i)} ${suffix(i)}`.trim();
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
