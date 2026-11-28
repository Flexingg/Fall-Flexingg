import type { FastStatus } from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { post } from '../lib/api';
import { keys, useFast } from '../lib/queries';
import { Icon } from './Icon';
import { ErrorBox, toast } from './ui';
import { invalidateSyncedData } from '../lib/syncedData';

const LENGTHS = [16, 18, 24];

function hm(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

/** Start and end fasts in SparkyFitness' tracker, for people in a fasting challenge. */
export function FastCard() {
  const q = useFast(true);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  async function run(path: string, body?: object, done?: string) {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(keys.fast, await post<FastStatus>(path, body));
      if (done) toast(done);
      void invalidateSyncedData(qc);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const active = q.data?.active;
  const started = active ? Date.parse(active.startedAt) : 0;
  const target = active?.targetEndAt ? Date.parse(active.targetEndAt) : null;
  const pct = active && target ? Math.min(1, (now - started) / (target - started)) : 0;

  return (
    <div className="card stack" style={{ gap: 10, marginTop: 12 }} aria-label="Fasting">
      <div className="row" style={{ gap: 10 }}>
        <Icon name="hourglass" size={22} />
        <div className="grow">
          <div style={{ fontWeight: 700 }}>
            {active ? `Fasting · ${hm(now - started)}` : 'Fasting challenge'}
          </div>
          <small className="muted">
            {active
              ? target
                ? now >= target
                  ? 'Target reached. End it when you eat.'
                  : `${hm(target - now)} to go`
                : 'No target set'
              : 'Start a fast when you finish eating.'}
          </small>
        </div>
      </div>
      {active && target && (
        <div className="track" aria-hidden>
          <i style={{ width: `${pct * 100}%` }} />
        </div>
      )}
      <ErrorBox error={q.error ?? error} />
      {active ? (
        <button
          className="btn"
          disabled={busy}
          onClick={() => run('/api/me/fast/end', undefined, 'Fast ended')}
        >
          End fast
        </button>
      ) : (
        <div className="row" style={{ gap: 8 }}>
          {LENGTHS.map((h) => (
            <button
              key={h}
              className="btn sm secondary grow"
              disabled={busy || q.isPending}
              onClick={() => run('/api/me/fast/start', { hours: h }, `${h}h fast started`)}
            >
              Start {h}h
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
