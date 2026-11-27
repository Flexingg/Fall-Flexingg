/**
 * The Today rings card: three rings and a legend (what each ring is, how far along, its goal in the
 * person's units). Tapping it opens the day screen with every stat for the day; pressing and holding
 * a ring opens "where did this come from" for that stat instead (a keyboard does that from the day
 * screen, where each row can take focus: the rows here sit inside the card's link).
 */
import {
  formatRingGoal,
  formatRingValue,
  ringFraction,
  ringShowsUnit,
  todayIn,
  type TodayRing,
} from '@gauntlet/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../lib/auth';
import { useDisplay } from '../lib/display';
import { useLongPress } from '../lib/useLongPress';
import { Icon } from './Icon';
import { RING_COLORS, Rings } from './Rings';
import { STAT_HINT_ID } from './StatSourceHint';
import { StatSourceSheet } from './StatSourceSheet';
import '../styles/rings.css';

export const ringValues = (rings: TodayRing[]): [number, number, number] => [
  ringFraction(rings[0]!),
  ringFraction(rings[1]!),
  ringFraction(rings[2]!),
];

function RingRow({
  r,
  color,
  onSource,
  focusable,
}: {
  r: TodayRing;
  color: string | undefined;
  onSource?: (r: TodayRing) => void;
  focusable: boolean;
}) {
  const display = useDisplay();
  const press = useLongPress(() => onSource?.(r));
  const unit = ringShowsUnit(r.unit);
  const extra = onSource
    ? {
        ...press,
        ...(focusable ? { role: 'button', tabIndex: 0, 'aria-describedby': STAT_HINT_ID } : {}),
        ...(focusable
          ? {
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSource(r);
                } else press.onKeyDown(e);
              },
            }
          : {}),
      }
    : {};
  return (
    <div className={`ring-row${onSource ? ' ss-press' : ''}`} data-testid="ring-row" {...extra}>
      <i style={{ background: color }} />
      <span className="rl">{r.label}</span>
      <span className="rv num">
        {formatRingValue(r, display, unit)}
        <small>of {formatRingGoal(r, display, unit)}</small>
      </span>
    </div>
  );
}

/**
 * One line per ring: label, value and "of goal". With `onSource`, pressing and holding a line opens
 * where that number came from; `focusable` also makes the lines keyboard-reachable buttons (not
 * inside a link).
 */
export function RingLegend({
  rings,
  onSource,
  focusable = true,
}: {
  rings: TodayRing[];
  onSource?: (r: TodayRing) => void;
  focusable?: boolean;
}) {
  return (
    <div className="ring-legend" data-testid="ring-legend">
      {rings.map((r, i) => (
        <RingRow
          key={r.metric}
          r={r}
          color={RING_COLORS[i]}
          onSource={onSource}
          focusable={focusable}
        />
      ))}
    </div>
  );
}

export function RingCard({ rings }: { rings: TodayRing[] }) {
  const { user } = useAuth();
  const [source, setSource] = useState<TodayRing | null>(null);
  return (
    <>
      <Link to="/day" className="card ring-card" data-testid="ring-card">
        <Rings values={ringValues(rings)} />
        <RingLegend rings={rings} onSource={setSource} focusable={false} />
        <Icon name="chevron" size={18} className="ring-chev" />
      </Link>
      {source && (
        <StatSourceSheet
          date={todayIn(user?.timezone ?? 'UTC')}
          metric={source.metric}
          label={source.label}
          onClose={() => setSource(null)}
        />
      )}
    </>
  );
}
