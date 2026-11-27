/**
 * "XP race" on your Badges page: everyone's total XP over time, you against the friends who share
 * their stats, drawn with the same chart as a challenge's progress graph so you can see who has been
 * leveling up faster. Range chips pick how far back. Quietly absent when the server can't give a
 * race (older server, or nothing to show yet).
 */
import { XP_RACE_RANGES, type XpRaceRange } from '@gauntlet/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { useXpRace } from '../lib/badgeQueries';
import { fmtDate, fmtInt, shortName } from '../lib/format';
import { LevelChip } from './LevelChip';
import { ProgressChart } from './ProgressChart';
import '../styles/badgeTimeline.css';

const RANGE_LABELS: Record<XpRaceRange, string> = {
  '30d': '30 days',
  '90d': '90 days',
  '1y': '1 year',
  all: 'All',
};

/** Year-long ranges cross years, so the dates along the bottom say month and year. */
const axisDate = (iso: string) => fmtDate(iso, { month: 'short', year: '2-digit' });

export function XpRaceCard() {
  const [range, setRange] = useState<XpRaceRange>('30d');
  const q = useXpRace(range);
  const d = q.data;
  if (!d) return null;

  const meIdx = d.series.findIndex((s) => s.isMe);
  const myTotal = meIdx >= 0 ? (d.series[meIdx]!.values.findLast((v) => v != null) ?? 0) : 0;
  const alone = d.series.length <= 1;
  // Nothing to race yet: just you, and no XP.
  if (alone && myTotal === 0) return null;

  return (
    <section data-testid="xp-race">
      <div className="lbl">
        <span>XP race</span>
      </div>
      <div className="card stack" style={{ gap: 12 }}>
        <div className="xr-chips" role="group" aria-label="How far back">
          {XP_RACE_RANGES.map((r) => (
            <button
              key={r}
              className="bd-chip"
              aria-pressed={range === r}
              onClick={() => setRange(r)}
            >
              {RANGE_LABELS[r]}
            </button>
          ))}
        </div>
        <ProgressChart
          data={{ ...d, lowerIsBetter: false, target: null, valueKind: 'metric' }}
          format={(v) => `${fmtInt(v)} XP`}
          axisDate={range === '1y' || range === 'all' ? axisDate : undefined}
          caption="Total XP over time."
        />
        {alone ? (
          <p className="muted xr-nudge">
            Add friends to see who is leveling up fastest. <Link to="/friends">Find friends</Link>
          </p>
        ) : (
          <ol className="xr-standings" aria-label="XP gained in this range">
            {d.series.map((s, i) => (
              <li key={s.user.id} className={s.isMe ? 'me' : ''}>
                <span className="xr-name">
                  {s.isMe ? 'You' : shortName(s.user.displayName)}
                  <LevelChip level={s.user.level} />
                </span>
                <b className="num">+{fmtInt(d.gained[i] ?? 0)} XP</b>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
