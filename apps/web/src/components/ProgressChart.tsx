import type { ChallengeProgress } from '@gauntlet/shared';
import { useMemo, useRef, useState } from 'react';
import { shortName } from '../lib/format';

/**
 * Seven hues validated together against the app's dark card (CVD and normal-vision separation,
 * contrast >= 3:1). The viewer is always the volt accent, which is not a categorical slot.
 */
const HUES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9', '#e66767'];
const ME = 'var(--volt)';

const W = 340;
const H = 210;
const M = { l: 40, r: 10, t: 12, b: 24 };

function niceTicks(min: number, max: number): number[] {
  if (max === min) return [min];
  const raw = (max - min) / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

const lastIndex = (values: (number | null)[]): number => {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return i;
  return -1;
};

const compact = (v: number) =>
  Math.abs(v) >= 1000 ? `${+(v / 1000).toFixed(1)}k` : `${+v.toFixed(1)}`;

const day = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

/** Everyone's score at the end of each day. Up always means ahead. */
export function ProgressChart({
  data,
  format,
}: {
  data: ChallengeProgress;
  /** Formats a value the way the leaderboard does (decimals, unit). */
  format: (v: number) => string;
}) {
  const { dates, series, lowerIsBetter } = data;
  const [hover, setHover] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const colors = useMemo(() => {
    // Stable per person, whatever their rank today.
    const others = series.filter((s) => !s.isMe).sort((a, b) => a.user.id.localeCompare(b.user.id));
    return new Map(
      series.map((s) => [
        s.user.id,
        s.isMe ? ME : HUES[others.findIndex((o) => o.user.id === s.user.id) % HUES.length]!,
      ]),
    );
  }, [series]);

  const nums = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  if (!nums.length)
    return <div className="notice">The graph appears after the first day of data.</div>;

  const lo = Math.min(0, ...nums);
  const hi = Math.max(...nums, lo + 1);
  const ticks = niceTicks(lo, hi);
  const top = Math.max(hi, ticks.at(-1) ?? hi);
  const x = (i: number) =>
    dates.length === 1 ? (M.l + W - M.r) / 2 : M.l + (i * (W - M.l - M.r)) / (dates.length - 1);
  const y = (v: number) => {
    const t = (v - lo) / (top - lo);
    return M.t + (lowerIsBetter ? t : 1 - t) * (H - M.t - M.b);
  };

  const pathFor = (values: (number | null)[]) => {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const name = (s: ChallengeProgress['series'][number]) =>
    s.isMe ? 'You' : shortName(s.user.displayName);
  // End-of-line names only when every pair has room (converging lines would collide); the
  // legend and the hover readout always carry identity.
  const endYs = series
    .map((s) => lastIndex(s.values))
    .flatMap((idx, i) => (idx >= 0 ? [y(series[i]!.values[idx]!)] : []))
    .sort((a, b) => a - b);
  const direct = series.length <= 4 && endYs.every((v, i) => i === 0 || v - endYs[i - 1]! >= 16);
  const at = hover ?? dates.length - 1;

  function point(clientX: number) {
    const box = wrap.current?.getBoundingClientRect();
    if (!box) return;
    const px = ((clientX - box.left) / box.width) * W;
    const i = Math.round(((px - M.l) / (W - M.l - M.r)) * (dates.length - 1));
    setHover(Math.min(Math.max(i, 0), dates.length - 1));
  }

  const rows = series
    .map((s) => ({ s, v: s.values[at] ?? null }))
    .sort((a, b) => (a.v == null ? 1 : b.v == null ? -1 : lowerIsBetter ? a.v - b.v : b.v - a.v));
  const xLabels = Array.from(new Set([0, Math.floor((dates.length - 1) / 2), dates.length - 1]));

  return (
    <div>
      <div
        ref={wrap}
        className="pchart"
        style={{ position: 'relative', touchAction: 'pan-y' }}
        onPointerMove={(e) => point(e.clientX)}
        onPointerDown={(e) => point(e.clientX)}
        onPointerLeave={() => setHover(null)}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label={`Progress by day. ${series
            .map(
              (s) =>
                `${name(s)} ${s.values.at(-1) == null ? 'no score' : format(s.values.at(-1)!)}`,
            )
            .join(', ')}.`}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setHover(Math.max(at - 1, 0));
            else if (e.key === 'ArrowRight') setHover(Math.min(at + 1, dates.length - 1));
            else if (e.key === 'Escape') setHover(null);
          }}
          onBlur={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={M.l}
                x2={W - M.r}
                y1={y(t)}
                y2={y(t)}
                stroke="var(--line)"
                strokeWidth={1}
              />
              <text x={M.l - 6} y={y(t) + 4} textAnchor="end" fontSize="10" fill="var(--muted)">
                {compact(t)}
              </text>
            </g>
          ))}
          {xLabels.map((i, k) => (
            <text
              key={i}
              x={x(i)}
              y={H - 6}
              fontSize="10"
              fill="var(--muted)"
              textAnchor={
                k === 0 && xLabels.length > 1
                  ? 'start'
                  : k === xLabels.length - 1 && xLabels.length > 1
                    ? 'end'
                    : 'middle'
              }
            >
              {day(dates[i]!)}
            </text>
          ))}
          {[...series]
            .sort((a, b) => Number(a.isMe) - Number(b.isMe))
            .map((s) => {
              const color = colors.get(s.user.id)!;
              const lastIdx = lastIndex(s.values);
              return (
                <g key={s.user.id}>
                  <path
                    d={pathFor(s.values)}
                    fill="none"
                    stroke={color}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  {lastIdx >= 0 && (
                    <circle
                      cx={x(lastIdx)}
                      cy={y(s.values[lastIdx]!)}
                      r={4}
                      fill={color}
                      stroke="var(--card)"
                      strokeWidth={2}
                    />
                  )}
                </g>
              );
            })}
          {hover != null && (
            <g>
              <line
                x1={x(at)}
                x2={x(at)}
                y1={M.t}
                y2={H - M.b}
                stroke="var(--dim)"
                strokeWidth={1}
              />
              {series.map(
                (s) =>
                  s.values[at] != null && (
                    <circle
                      key={s.user.id}
                      cx={x(at)}
                      cy={y(s.values[at]!)}
                      r={4}
                      fill={colors.get(s.user.id)}
                      stroke="var(--card)"
                      strokeWidth={2}
                    />
                  ),
              )}
            </g>
          )}
        </svg>
        {direct &&
          hover == null &&
          series.map((s) => {
            const idx = lastIndex(s.values);
            if (idx < 0) return null;
            return (
              <span
                key={s.user.id}
                className="pchart-end"
                style={{
                  left: `${(Math.min(x(idx), W - M.r) / W) * 100}%`,
                  top: `${((y(s.values[idx]!) - 18) / H) * 100}%`,
                }}
              >
                {name(s)}
              </span>
            );
          })}
        {hover != null && (
          <div
            className="pchart-tip"
            role="status"
            style={{
              left: `${Math.min(Math.max((x(at) / W) * 100, 24), 76)}%`,
            }}
          >
            <small>{day(dates[at]!)}</small>
            {rows.map(({ s, v }) => (
              <div key={s.user.id} className="row" style={{ gap: 6 }}>
                <i
                  aria-hidden
                  style={{
                    width: 12,
                    height: 2,
                    borderRadius: 1,
                    background: colors.get(s.user.id),
                  }}
                />
                <b className="num">{v == null ? '–' : format(v)}</b>
                <small className="ellipsis">{name(s)}</small>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: '4px 14px', marginTop: 8 }}>
        {series.map((s) => (
          <span key={s.user.id} className="row" style={{ gap: 6, fontSize: 12 }}>
            <i
              aria-hidden
              style={{ width: 14, height: 2, borderRadius: 1, background: colors.get(s.user.id) }}
            />
            <span className="muted">{name(s)}</span>
          </span>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
        {lowerIsBetter
          ? 'Lower is better, so the best line is at the top.'
          : 'Score at the end of each day.'}
        {data.truncated && ` Showing the top ${series.length} of ${data.total}.`}
      </p>
      <details style={{ marginTop: 6 }}>
        <summary className="muted" style={{ fontSize: 12 }}>
          Table
        </summary>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ fontSize: 12, borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th scope="col" style={{ textAlign: 'left' }}>
                  Day
                </th>
                {series.map((s) => (
                  <th key={s.user.id} scope="col" style={{ textAlign: 'right' }}>
                    {name(s)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...dates.keys()].reverse().map((i) => (
                <tr key={dates[i]}>
                  <th scope="row" style={{ textAlign: 'left', fontWeight: 500 }}>
                    {day(dates[i]!)}
                  </th>
                  {series.map((s) => (
                    <td key={s.user.id} className="num" style={{ textAlign: 'right' }}>
                      {s.values[i] == null ? '–' : format(s.values[i]!)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
