import type { WorkoutDetail, WorkoutExercise } from '@gauntlet/shared';
import { useParams, useSearchParams } from 'react-router';
import { Empty, ErrorBox, Header, Screen, Skeleton } from '../components/ui';
import { ApiError } from '../lib/api';
import { useWorkout } from '../lib/statsQueries';
import '../styles/stats.css';

const n = (v: number, digits = 0) =>
  v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });

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
      {q.isPending && <Skeleton height={260} />}
      {w && <Body w={w} />}
    </Screen>
  );
}

function Body({ w }: { w: WorkoutDetail }) {
  const when = whenText(w);
  const stats: [string, string][] = [];
  if (w.minutes != null) stats.push([n(w.minutes), 'minutes']);
  if (w.distanceKm != null) stats.push([n(w.distanceKm, 1), 'km']);
  if (w.kcal != null) stats.push([n(w.kcal), 'kcal']);
  if (w.avgHeartRate != null) stats.push([n(w.avgHeartRate), 'avg heart rate (bpm)']);
  if (w.volumeKg != null) stats.push([n(w.volumeKg), 'kg total volume']);

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
                  {s.reps} × {s.kg > 0 ? `${n(s.kg, 1)} kg` : 'bodyweight'}
                </td>
                <td className="num">{s.e1rm != null ? `${n(s.e1rm, 1)} kg` : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
          <small className="muted">
            Volume <b className="num">{n(e.volumeKg)} kg</b>
          </small>
          {e.bestE1rm != null && (
            <small className="muted">
              Best est. 1RM <b className="num">{n(e.bestE1rm, 1)} kg</b>
            </small>
          )}
        </div>
      </div>
    </section>
  );
}

function whenText(w: WorkoutDetail): string {
  const day = new Date(`${w.date}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
  if (!w.startedAt) return day;
  const time = new Date(w.startedAt).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${day} at ${time}`;
}
