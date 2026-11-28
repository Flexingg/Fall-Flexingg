import { HISTORY_RANGES, HISTORY_SUPPORT, todayIn, type HistoryStep } from '@gauntlet/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import '../styles/history.css';
import { useAuth } from '../lib/auth';
import {
  healthAvailable,
  healthHistoryAccess,
  openHealthSettings,
  pendingHealthHistory,
  requestHealthHistoryAccess,
} from '../lib/health';
import {
  cancelPhoneImport,
  historyApi,
  importableApps,
  runPhoneImport,
  usePhoneImport,
  type PhoneStep,
} from '../lib/history';
import {
  headline,
  stepLabel,
  stepPercent,
  summaryLine,
  type HistoryAccess,
} from '../lib/historyPlan';
import { isNative, timezone } from '../lib/platform';
import { keys, useConnections } from '../lib/queries';
import { ErrorBox, toast } from './ui';
import { invalidateSyncedData } from '../lib/syncedData';

/**
 * Settings > Data sources > Import history. Pick how far back, press Import, watch each source.
 * With a Gauntlet server the import is a background job there (you can leave the screen); the
 * phone's own part, Health Connect's older data, runs here and needs the app open.
 */
export function HistoryImport() {
  const { user, mode } = useAuth();
  const direct = mode === 'direct';
  const qc = useQueryClient();
  const conns = useConnections();
  const phone = usePhoneImport();
  const [rangeKey, setRangeKey] = useState<(typeof HISTORY_RANGES)[number]['key']>('1y');
  const [error, setError] = useState<unknown>(null);
  const [hcReady, setHcReady] = useState(false);
  const [access, setAccess] = useState<HistoryAccess | null>(null);
  const [resumable, setResumable] = useState(false);
  const days = HISTORY_RANGES.find((r) => r.key === rangeKey)!.days;

  const status = useQuery({
    queryKey: keys.history,
    queryFn: historyApi.status,
    enabled: !direct,
    refetchInterval: (q) => (q.state.data?.running ? 3000 : false),
  });
  const job = status.data;
  const serverRunning = !!job?.running;
  const busy = phone.running || serverRunning;

  const useHc = isNative && hcReady && !!user?.settings.healthConnectSync;
  const apps = direct ? importableApps(conns.data) : [];

  useEffect(() => {
    if (!isNative) return;
    void healthAvailable().then((h) => setHcReady(h.available));
    void healthHistoryAccess().then(setAccess);
    void pendingHealthHistory().then((p) => setResumable(!!p));
  }, [phone.running]);

  // When a server job ends, the numbers on every other screen are out of date.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !serverRunning) {
      void invalidateSyncedData(qc);
      if (job?.state === 'done') toast('History imported');
    }
    wasRunning.current = serverRunning;
  }, [serverRunning, job?.state, qc]);

  async function start() {
    setError(null);
    try {
      let proceed = true;
      if (useHc || apps.length) {
        proceed = await runPhoneImport({ days, healthConnect: useHc, apps });
        void invalidateSyncedData(qc);
      }
      // The server reads SparkyFitness after the phone has sent its data there.
      if (proceed && !direct) qc.setQueryData(keys.history, await historyApi.start(days));
    } catch (err) {
      setError(err);
    }
  }

  async function stop() {
    if (phone.running) return cancelPhoneImport();
    try {
      qc.setQueryData(keys.history, await historyApi.cancel());
    } catch (err) {
      setError(err);
    }
  }

  async function allowPastData() {
    setAccess(await requestHealthHistoryAccess());
  }

  const limits = (conns.data ?? [])
    .filter((c) => c.state === 'connected' && HISTORY_SUPPORT[c.id].note)
    .filter((c) => c.id !== 'wger');
  const rows: (HistoryStep | PhoneStep)[] = [...phone.steps, ...(job?.steps ?? [])];
  const canStart = !busy && (!direct || useHc || apps.length > 0);
  const end = job?.range?.end ?? todayIn(timezone);
  const ended = job && !job.running && job.state !== 'idle';
  const finished = !busy && (ended || (phone.steps.length > 0 && phone.cancelled));

  return (
    <div className="card stack hi" id="history-import" style={{ gap: 12 }}>
      <div>
        <div style={{ fontWeight: 700 }}>Import history</div>
        <small className="muted hi-lead">
          Imports your older data so Trends, records and badges include it. Big imports can take a
          while
          {direct ? '.' : ' — you can leave this screen.'}
        </small>
      </div>

      {direct && (
        <small className="muted hi-lead">
          Without a Gauntlet server, Gauntlet itself shows your last two months. This fills
          SparkyFitness with older data, and a Gauntlet server will show all of it when you connect
          one.
        </small>
      )}

      <div className="seg" role="group" aria-label="How far back">
        {HISTORY_RANGES.map((r) => (
          <button
            key={r.key}
            aria-pressed={rangeKey === r.key}
            disabled={busy}
            onClick={() => setRangeKey(r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>

      {limits.length > 0 && rows.length === 0 && (
        <ul className="hi-limits">
          {limits.map((c) => (
            <li key={c.id}>
              <b>{c.label}:</b> {HISTORY_SUPPORT[c.id].note}
            </li>
          ))}
        </ul>
      )}

      {isNative && hcReady && access === 'not_granted' && !busy && (
        <div className="hi-hint" role="note">
          <span>
            Health Connect only lets Gauntlet read the last 30 days until you allow past data.
          </span>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm" onClick={allowPastData}>
              Allow past data
            </button>
            <button className="btn sm secondary" onClick={() => openHealthSettings()}>
              Open Health Connect
            </button>
          </div>
        </div>
      )}
      {isNative && hcReady && access === 'unsupported' && !busy && (
        <div className="hi-hint" role="note">
          This version of Health Connect only keeps 30 days for apps, so older phone data can’t be
          imported. Garmin, Strava and other linked apps are not affected.
        </div>
      )}
      {isNative && !user?.settings.healthConnectSync && !busy && (
        <small className="muted">
          Turn on Health Connect above to include this phone’s history.
        </small>
      )}

      {rows.length > 0 && (
        <div className="hi-rows">
          {rows.map((s) => (
            <StepRow key={s.source} step={s} />
          ))}
        </div>
      )}

      {finished && job && (
        <div className={`hi-done ${job.state}`} role="status">
          <b>{headline(job)}</b>
          {job.summary && <span>{summaryLine(job.summary, end)}</span>}
          {job.error && <span className="hi-err">{job.error}</span>}
        </div>
      )}
      {busy ? (
        <button className="btn secondary" onClick={stop}>
          Cancel import
        </button>
      ) : (
        <button className="btn" disabled={!canStart} onClick={start}>
          {resumable && useHc ? 'Continue import' : 'Import history'}
        </button>
      )}
      {!canStart && !busy && direct && (
        <small className="muted">Connect an app or turn on Health Connect first.</small>
      )}

      {!busy && phone.cancelled && !job?.running && (
        <small className="muted">Stopped. What was imported is kept.</small>
      )}
      <ErrorBox error={error ?? status.error} />
    </div>
  );
}

function StepRow({ step }: { step: HistoryStep | PhoneStep }) {
  const pct = stepPercent(step);
  return (
    <div className={`hi-row ${step.state}`}>
      <div className="row" style={{ gap: 8 }}>
        <span className="grow hi-name">{step.label}</span>
        <span className="hi-state">{stepLabel(step)}</span>
      </div>
      <div
        className="hi-bar"
        role="progressbar"
        aria-label={step.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <i style={{ width: `${pct}%` }} />
      </div>
      {step.error && <small className="hi-err">{step.error}</small>}
      {!step.error && step.note && <small className="muted">{step.note}</small>}
    </div>
  );
}
