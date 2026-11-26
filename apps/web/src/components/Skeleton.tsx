/**
 * Loading placeholders shaped like what is about to arrive (a card, a row with an avatar, a chart),
 * so the screen keeps its size when the data lands. Each composite carries aria-busy and
 * aria-label="Loading" once; the bars inside are decoration. The shimmer stops under
 * prefers-reduced-motion (see skeleton.css). Show these only while there is no data at all
 * (React Query's isPending), never over cached data that is merely refreshing.
 */
import type { CSSProperties, ReactNode } from 'react';
import '../styles/skeleton.css';

const busy = { 'aria-busy': true, 'aria-label': 'Loading', role: 'status' } as const;

export function SkeletonLine({
  width = '100%',
  height = 12,
  style,
}: {
  width?: number | string;
  height?: number;
  style?: CSSProperties;
}) {
  return <span className="sk-bar" style={{ width, height, ...style }} aria-hidden="true" />;
}

function SkeletonCircle({ size }: { size: number }) {
  return <span className="sk-circle" style={{ width: size, height: size }} aria-hidden="true" />;
}

/** A card: a title bar then `lines` text bars, or your own placeholder shapes as children. */
export function SkeletonCard({
  lines = 3,
  children,
  style,
}: {
  lines?: number;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className="card sk-card" style={style} {...busy}>
      {children ?? (
        <>
          <SkeletonLine width="45%" height={16} />
          {Array.from({ length: lines }, (_, i) => (
            <SkeletonLine key={i} width={i === lines - 1 ? '70%' : '100%'} />
          ))}
        </>
      )}
    </div>
  );
}

/** One list row: avatar and two lines. Used inside SkeletonList. */
export function SkeletonRow({ avatar = 40 }: { avatar?: number | null }) {
  return (
    <div className="item sk-row" aria-hidden="true">
      {avatar != null && <SkeletonCircle size={avatar} />}
      <div className="sk-text">
        <SkeletonLine width="55%" height={14} />
        <SkeletonLine width="35%" />
      </div>
    </div>
  );
}

/** A `.list` of rows. */
export function SkeletonList({ rows = 4, avatar }: { rows?: number; avatar?: number | null }) {
  return (
    <div className="list" {...busy}>
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonRow key={i} avatar={avatar} />
      ))}
    </div>
  );
}

/** A bar or line chart's frame: a title bar and columns of varying height. */
export function SkeletonChart({
  height = 160,
  bars = 7,
  card = true,
}: {
  height?: number;
  bars?: number;
  card?: boolean;
}) {
  const heights = [55, 80, 40, 95, 65, 75, 50, 90, 60, 70];
  const chart = (
    <>
      <SkeletonLine width="40%" height={14} />
      <div className="sk-chart" style={{ height }} aria-hidden="true">
        {Array.from({ length: bars }, (_, i) => (
          <span
            key={i}
            className="sk-block"
            style={{ height: `${heights[i % heights.length]}%` }}
          />
        ))}
      </div>
    </>
  );
  return card ? (
    <div className="card sk-card" {...busy}>
      {chart}
    </div>
  ) : (
    <div className="sk-card" {...busy}>
      {chart}
    </div>
  );
}

/** Wraps several placeholders that load together, so they are announced once. */
export function SkeletonGroup({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="stack" style={style} {...busy}>
      {children}
    </div>
  );
}
