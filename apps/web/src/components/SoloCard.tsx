import {
  formatMetricValue,
  metricDef,
  SOLO_STATUS_LABELS,
  type ChallengeDetail,
  type SoloStatus,
} from '@gauntlet/shared';
import { dateRange, fmt, fmtSolo } from '../lib/format';

const TONE: Record<SoloStatus, string> = {
  upcoming: 'plain',
  ahead: '',
  on_track: '',
  behind: 'plain',
  achieved: '',
  missed: 'plain',
};

/** One sentence on where you stand, in plain words. */
export function soloSentence(c: ChallengeDetail): string {
  const s = c.solo;
  if (!s) return '';
  const per = (v: number) => fmt(v, c);
  const label = c.metricLabel.replace(/ (total|per day|streak|vs before)$/, '').toLowerCase();
  switch (s.status) {
    case 'upcoming':
      return `Starts ${dateRange(c.startDate, c.startDate)}.`;
    case 'achieved':
      return s.kind === 'improve'
        ? 'You beat your past self. Nicely done.'
        : s.kind === 'streak'
          ? 'Streak complete. Nicely done.'
          : 'Goal reached. Nicely done.';
    case 'missed':
      return s.kind === 'streak'
        ? "The streak can't be reached now."
        : s.kind === 'improve' && !s.baseline
          ? 'There was no earlier data to compare with.'
          : 'Not this time. Run it again with a Rematch.';
    default:
  }
  if (s.kind === 'target' && s.perDayNeeded != null && s.remaining != null)
    return s.remaining <= 0
      ? 'Goal reached.'
      : `${per(s.remaining)} to go: ${per(s.perDayNeeded)} a day over the next ${s.daysLeft} ${s.daysLeft === 1 ? 'day' : 'days'}.`;
  if (s.kind === 'average')
    return s.status === 'behind'
      ? `${per(s.remaining ?? 0)} a day short of your goal so far.`
      : 'Your daily average is where you want it.';
  if (s.kind === 'streak') return `${s.target! - (s.current ?? 0)} more days in a row to go.`;
  if (s.kind === 'improve') {
    if (!s.baseline)
      return `No ${label} data from the days before it started, so there is nothing to compare with yet.`;
    return s.status === 'ahead'
      ? 'You are beating your past self right now. Keep it up.'
      : `${Math.max(s.remaining ?? 0, 0).toFixed(1)} points of improvement to go.`;
  }
  return '';
}

/** How you are doing against your own goal: the big number, a bar with an even-pace marker, and a plain sentence. */
export function SoloCard({ c }: { c: ChallengeDetail }) {
  const s = c.solo;
  if (!s) return null;
  const pct = Math.round(s.progress * 100);
  const marker =
    s.kind === 'target' && s.expected != null && s.target
      ? Math.min(s.expected / s.target, 1)
      : null;
  const showTarget = s.target != null;
  return (
    <div className="card stack" style={{ gap: 12, marginBottom: 14 }} aria-label="Your progress">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <small className="muted">
          {s.kind === 'target'
            ? 'Total so far'
            : s.kind === 'average'
              ? 'Daily average'
              : s.kind === 'streak'
                ? 'Best streak'
                : 'Change vs before'}
        </small>
        <span className={`pill ${TONE[s.status]}`}>{SOLO_STATUS_LABELS[s.status]}</span>
      </div>
      <div className="big num">
        {fmtSolo(s.current, s.valueKind, c)}
        {showTarget && (
          <small>
            {' '}
            of {fmtSolo(s.target, s.valueKind, c)}
            {s.kind === 'average' ? ' a day' : ''}
          </small>
        )}
      </div>
      <div
        className="track"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Progress toward the goal"
        style={{ position: 'relative' }}
      >
        <i style={{ width: `${pct}%` }} />
        {marker != null && (
          <b
            aria-hidden
            title="An even pace"
            style={{
              position: 'absolute',
              left: `${marker * 100}%`,
              top: -3,
              bottom: -3,
              width: 2,
              background: 'var(--text)',
              opacity: 0.55,
            }}
          />
        )}
      </div>
      <div className="row muted" style={{ justifyContent: 'space-between', fontSize: 12 }}>
        <span>{pct}% of the way</span>
        {marker != null && s.expected != null && <span>Even pace: {fmt(s.expected, c)}</span>}
        <span>
          {s.daysLeft} {s.daysLeft === 1 ? 'day' : 'days'} left
        </span>
      </div>
      {s.kind === 'improve' && s.baseline && (
        <small className="muted" style={{ lineHeight: 1.45 }}>
          Compared with your {c.metricLabel.replace(/ vs before$/, '').toLowerCase()} over the{' '}
          {s.baseline.days} days before ({dateRange(s.baseline.from, s.baseline.to)}):{' '}
          {formatMetricValue(s.baseline.value, metricDef(c.metric))} a day.
        </small>
      )}
      <p style={{ fontSize: 14, lineHeight: 1.45 }}>{soloSentence(c)}</p>
    </div>
  );
}
