import type { CompareMetric } from '@gauntlet/shared';
import { useState } from 'react';
import { fmtInt, fmtQty, unitLabel } from '../lib/format';
import { useCompare } from '../lib/statsQueries';
import '../styles/stats.css';
import { SkeletonCard } from './Skeleton';
import { ErrorBox, Seg } from './ui';

const fmt = (v: number, key: string, unit: string) =>
  key === 'distance' ? fmtQty(v, unit, 1, false) : fmtInt(v);

/**
 * "Head to head" on someone else's profile: you and them over a range, a two-sided bar for each
 * stat, and your record in challenges you both finished. Their numbers only come back when they
 * share their stats; otherwise just the record (the server decides, this only shows what it sent).
 */
export function HeadToHead({ userId }: { userId: string }) {
  const [range, setRange] = useState<'day' | 'week' | 'month'>('week');
  const q = useCompare(userId, range);
  const c = q.data;
  const first = c?.theirName.split(' ')[0] ?? 'Them';

  return (
    <section aria-label="Head to head">
      <div className="lbl">Head to head</div>
      <ErrorBox error={q.error} />
      {q.isPending && <SkeletonCard lines={4} />}
      {c && (
        <div className="stack" style={{ gap: 10, opacity: q.isFetching ? 0.6 : 1 }}>
          {c.record.shared > 0 ? (
            <div className="card h2h-score" aria-label="Challenge record">
              You {c.record.me} – {c.record.them} {first}
              <small>
                in {c.record.shared} finished {c.record.shared === 1 ? 'challenge' : 'challenges'}{' '}
                together
              </small>
            </div>
          ) : (
            <div className="card">
              <small className="muted">No finished challenges together yet.</small>
            </div>
          )}
          {c.theirsHidden ? (
            <div className="card">
              <small className="muted">
                {first} keeps their stats private, so only your challenge record is shown.
              </small>
            </div>
          ) : (
            <>
              <Seg
                label="Compare over"
                value={range}
                onChange={setRange}
                options={[
                  { value: 'day', label: '7 days' },
                  { value: 'week', label: 'Week' },
                  { value: 'month', label: 'Month' },
                ]}
              />
              {c.metrics.length === 0 ? (
                <div className="card">
                  <small className="muted">Neither of you has data for this period yet.</small>
                </div>
              ) : (
                <div className="list">
                  {c.metrics.map((m) => (
                    <Row key={m.key} m={m} first={first} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Row({ m, first }: { m: CompareMetric; first: string }) {
  const them = m.them ?? 0;
  const top = Math.max(m.me, them) || 1;
  const lead = m.me === them ? null : m.me > them ? 'me' : 'them';
  const unit = m.unit ? ` ${unitLabel(m.unit)}` : '';
  return (
    <div
      className="h2h-row"
      role="group"
      aria-label={`${m.label}: you ${fmt(m.me, m.key, m.unit)}${unit}, ${first} ${fmt(them, m.key, m.unit)}${unit}. ${
        lead === 'me' ? 'You are ahead.' : lead === 'them' ? `${first} is ahead.` : 'Level.'
      }`}
    >
      <div className="h2h-vals" aria-hidden="true">
        <span className={`num${lead === 'me' ? ' lead' : ''}`}>
          {fmt(m.me, m.key, m.unit)}
          {unit && <small className="muted">{unit}</small>}
        </span>
        <span className="mid">{m.label}</span>
        <span className={`num${lead === 'them' ? ' lead' : ''}`}>
          {fmt(them, m.key, m.unit)}
          {unit && <small className="muted">{unit}</small>}
        </span>
      </div>
      <div className="h2h-bar" aria-hidden="true">
        <div>
          <i className={lead === 'me' ? 'lead' : ''} style={{ width: `${(m.me / top) * 100}%` }} />
        </div>
        <div>
          <i
            className={lead === 'them' ? 'lead' : ''}
            style={{ width: `${(them / top) * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}
