import type { MeUser } from '@gauntlet/shared';
import { useEffect, useState } from 'react';
import { Connections } from '../components/Connections';
import { Icon } from '../components/Icon';
import { ErrorBox, Header, Screen, Skeleton, toast, Toggle } from '../components/ui';
import { useAuth } from '../lib/auth';
import {
  healthAvailable,
  openHealthSettings,
  requestHealthAccess,
  syncHealthConnect,
} from '../lib/health';
import { isNative } from '../lib/platform';
import { useSources } from '../lib/queries';
import { updateSettings } from '../lib/session';

export function SourcesPage() {
  const q = useSources();
  const { user, setUser, mode } = useAuth();
  const [error, setError] = useState<unknown>(null);
  const [hc, setHc] = useState<{ available: boolean; reason?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    healthAvailable().then(setHc);
  }, []);

  async function save(settings: Partial<MeUser['settings']>) {
    try {
      setUser(await updateSettings(settings));
    } catch (err) {
      setError(err);
    }
  }

  async function toggleHealthConnect(on: boolean) {
    setError(null);
    if (!on) return save({ healthConnectSync: false });
    setBusy(true);
    try {
      if (!(await requestHealthAccess())) {
        setError(new Error('Health Connect access was not granted. Allow at least Steps.'));
        return;
      }
      await save({ healthConnectSync: true });
      const n = await syncHealthConnect({ days: 30 });
      toast(`Sent ${n} records to SparkyFitness`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const hasHcInSparky = q.data?.providers.some((p) => p.label === 'Health Connect');

  return (
    <Screen>
      <Header title="Data sources" back="/me" />
      <p className="muted" style={{ fontSize: 14, lineHeight: 1.45, margin: '-4px 0 14px' }}>
        Your health data lives in SparkyFitness. Connect devices there, and Gauntlet scores
        challenges from it.
      </p>
      <ErrorBox error={q.error ?? error} />

      <Connections />

      <div className="lbl">Synced into SparkyFitness</div>
      {q.isPending ? (
        <Skeleton height={140} />
      ) : (
        <div className="list">
          {q.data?.providers.length === 0 && (
            <div className="item">
              <span className="muted">Nothing synced yet.</span>
            </div>
          )}
          {q.data?.providers.map((p) => (
            <div key={p.source} className="item">
              <div
                className="av"
                style={{
                  borderRadius: 12,
                  width: 42,
                  height: 42,
                  color: 'var(--volt)',
                  fontSize: 14,
                }}
              >
                {p.label[0]}
              </div>
              <div className="grow">
                <div className="t">{p.label}</div>
                <small>{p.records.toLocaleString('en-US')} records</small>
              </div>
              <i className="dot" aria-label="Connected" />
            </div>
          ))}
          {q.data && (
            <a className="item" href={q.data.integrationsUrl} target="_blank" rel="noreferrer">
              <div className="av" style={{ borderRadius: 12, width: 42, height: 42 }}>
                <Icon name="plus" size={20} />
              </div>
              <div className="grow">
                <div className="t">More in SparkyFitness</div>
                <small>Other integrations, in SparkyFitness settings</small>
              </div>
              <Icon name="chevron" size={18} />
            </a>
          )}
        </div>
      )}

      <div className="lbl">On this phone</div>
      <div className="list">
        <div className="item">
          <div
            className="av"
            style={{ borderRadius: 12, width: 42, height: 42, color: 'var(--volt)', fontSize: 14 }}
          >
            H
          </div>
          <div className="grow">
            <div className="t">Health Connect</div>
            <small>
              {isNative
                ? hc?.available === false
                  ? (hc.reason ?? 'Not available on this device')
                  : 'Steps, distance, calories, sleep, workouts'
                : 'Available in the Android app'}
            </small>
          </div>
          {busy ? (
            <span className="spinner" />
          ) : (
            <Toggle
              checked={!!user?.settings.healthConnectSync}
              disabled={!isNative || hc?.available === false}
              onChange={toggleHealthConnect}
              label="Sync Health Connect"
            />
          )}
        </div>
        {isNative && user?.settings.healthConnectSync && (
          <button className="item" onClick={() => openHealthSettings()}>
            <div className="grow">
              <div className="t">Health Connect permissions</div>
            </div>
            <Icon name="chevron" size={18} />
          </button>
        )}
      </div>
      {isNative && hasHcInSparky && !user?.settings.healthConnectSync && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          SparkyFitness already has Health Connect data (probably from the SparkyFitness app). You
          only need one of them syncing.
        </p>
      )}

      {mode !== 'direct' && (
        <>
          <div className="lbl">Privacy</div>
          <div className="list">
            <div className="item">
              <div className="grow">
                <div className="t">Show my data sources</div>
                <small>
                  Friends see "Garmin" or "Strava" on your activity. Totals are always shared in
                  challenges.
                </small>
              </div>
              <Toggle
                checked={!!user?.settings.shareWorkoutDetails}
                onChange={(v) => save({ shareWorkoutDetails: v })}
                label="Show my data sources"
              />
            </div>
          </div>
        </>
      )}
    </Screen>
  );
}
