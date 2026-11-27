/**
 * The Today rings card: three rings and a legend (what each ring is, how far along, its goal in the
 * person's units). Tapping it opens the day screen with every stat for the day.
 */
import {
  formatRingGoal,
  formatRingValue,
  ringFraction,
  ringShowsUnit,
  type TodayRing,
} from '@gauntlet/shared';
import { Link } from 'react-router';
import { useDisplay } from '../lib/display';
import { Icon } from './Icon';
import { RING_COLORS, Rings } from './Rings';
import '../styles/rings.css';

export const ringValues = (rings: TodayRing[]): [number, number, number] => [
  ringFraction(rings[0]!),
  ringFraction(rings[1]!),
  ringFraction(rings[2]!),
];

/** One line per ring: label, value and "of goal". */
export function RingLegend({ rings }: { rings: TodayRing[] }) {
  const display = useDisplay();
  return (
    <div className="ring-legend" data-testid="ring-legend">
      {rings.map((r, i) => {
        const unit = ringShowsUnit(r.unit);
        return (
          <div key={r.metric} className="ring-row">
            <i style={{ background: RING_COLORS[i] }} />
            <span className="rl">{r.label}</span>
            <span className="rv num">
              {formatRingValue(r, display, unit)}
              <small>of {formatRingGoal(r, display, unit)}</small>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function RingCard({ rings }: { rings: TodayRing[] }) {
  return (
    <Link to="/day" className="card ring-card" data-testid="ring-card">
      <Rings values={ringValues(rings)} />
      <RingLegend rings={rings} />
      <Icon name="chevron" size={18} className="ring-chev" />
    </Link>
  );
}
