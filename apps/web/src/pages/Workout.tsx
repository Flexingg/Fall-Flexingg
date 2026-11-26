import type { WorkoutDetail, WorkoutExercise } from '@gauntlet/shared';
import { useParams, useSearchParams } from 'react-router';
import { Empty, ErrorBox, Header, Screen } from '../components/ui';
import { SkeletonCard, SkeletonGroup, SkeletonList } from '../components/Skeleton';
import { ApiError } from '../lib/api';
import { fmtDate, fmtFlex, fmtQty, fmtTime, fmtWallTime, unitLabel } from '../lib/format';
import { useWorkout } from '../lib/statsQueries';
import '../styles/stats.css';

const n = (v: number, digits = 0) => fmtFlex(v, digits);

/** One workout: the numbers, and for strength every exercise with its sets. Read live, never stored. */
export function WorkoutPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const q = useWorkout(id, params.get('u'));
  const w = q.data;

  return (
    <Screen>
      <Header title={w?.name ?? 'Workout'} back />
      {q.error instanceof ApiError && q.error.status === 404 ? (
        <div className="list">
          <Empty title="Workout not available">
            It may be older than SparkyFitness keeps, or its owner keeps workouts private.
          </Empty>
        </div>
      ) : (
        <ErrorBox error={q.error} />
      )}
      {q.isPending && (
        <SkeletonGroup>
          <SkeletonCard lines={2} />
          <SkeletonList rows={4} avatar={null} />
        </SkeletonGroup>
      )}
      {w && <Body w={w} />}
    </Screen>
  );
}

function Body({ w }: { w: WorkoutDetail }) {
  const when = whenText(w);
  const stats: [string, string][] = [];
  if (w.minutes != null) stats.push([n(w.minutes), 'minutes']);
  if (w.distanceKm != null) stats.push([fmtQty(w.distanceKm, 'km', 1, false), unitLabel('km')]);
  if (w.kcal != null) stats.push([n(w.kcal), 'kcal']);
  if (w.avgHeartRate != null) stats.push([n(w.avgHeartRate), 'avg heart rate (bpm)']);
  if (w.volumeKg != null)
    stats.push([fmtQty(w.volumeKg, 'kg', 0, false), `${unitLabel('kg')} total volume`]);

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <small className="muted">
          {!w.owner.isMe && `${w.owner.displayName} · `}
          {when}
        </small>
        {w.source && <span className="pill plain">{w.source}</span>}
      </div>
      {stats.length > 0 && (
        <div className="wk-stats">
          {stats.map(([v, label]) => (
            <div key={label}>
              <b className="num">{v}</b>
              <span>{label}</span>
            </div>
          ))}
        </div>
      )}
      {w.exercises.map((e) => (
        <Exercise key={e.name} e={e} />
      ))}
      {w.kind === 'cardio' && stats.length === 0 && (
        <div className="card">
          <small className="muted">No other details were recorded for this workout.</small>
        </div>
      )}
    </div>
  );
}

function Exercise({ e }: { e: WorkoutExercise }) {
  // Warm-ups aren't numbered: the first working set is set 1.
  let working = 0;
  const label = e.sets.map((s) => (s.warmup ? 'Warm-up' : String(++working)));
  return (
    <section aria-label={e.name}>
      <div className="lbl">{e.name}</div>
      <div className="card">
        <table className="wk-sets">
          <thead>
            <tr>
              <th>Set</th>
              <th>Reps × weight</th>
              <th>Est. 1RM</th>
            </tr>
          </thead>
          <tbody>
            {e.sets.map((s, i) => (
              <tr key={i} className={s.warmup ? 'warm' : ''}>
                <td>{label[i]}</td>
                <td className="num">
                  {s.reps} × {s.kg > 0 ? fmtQty(s.kg, 'kg', 1) : 'bodyweight'}
                </td>
                <td className="num">{s.e1rm != null ? fmtQty(s.e1rm, 'kg', 1) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
          <small className="muted">
            Volume <b className="num">{fmtQty(e.volumeKg, 'kg', 0)}</b>
          </small>
          {e.bestE1rm != null && (
            <small className="muted">
              Best est. 1RM <b className="num">{fmtQty(e.bestE1rm, 'kg', 1)}</b>
            </small>
          )}
        </div>
      </div>
    </section>
  );
}

function whenText(w: WorkoutDetail): string {
  const day = fmtDate(w.date, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  if (!w.startedAt) {
    // Only a local wall-clock time ("07:37") is known: show it as written, no time-zone maths.
    return w.startTime ? `${day} at ${fmtWallTime(w.startTime)}` : day;
  }
  return `${day} at ${fmtTime(w.startedAt)}`;
}
