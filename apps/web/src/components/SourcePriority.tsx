import type { SourcePriorityResponse } from '@gauntlet/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { get, put } from '../lib/api';
import { describeSync, useSyncNow } from '../lib/freshness';
import { timeAgo } from '../lib/format';
import { keys } from '../lib/queries';
import { Icon } from './Icon';
import { ErrorBox, Skeleton, toast } from './ui';

/** "Sync now": Health Connect, every connected app, and SparkyFitness, with when it last ran. */
export function SyncNowCard({ lastSyncedAt }: { lastSyncedAt: string | null | undefined }) {
  const { busy, sync } = useSyncNow();
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 12 }}>
        <div className="grow">
          <div style={{ fontWeight: 700 }}>Fresh data</div>
          <small className="muted">
            {busy ? 'Syncing…' : `Last synced ${timeAgo(lastSyncedAt ?? null)}`}
          </small>
        </div>
        <button
          className="btn sm"
          disabled={busy}
          onClick={async () => {
            const r = await sync(true);
            const msg = r ? describeSync(r) : 'Sync failed. Try again in a minute.';
            setNote(msg);
            toast(msg);
          }}
        >
          <Icon name="refresh" size={14} className={busy ? 'spin' : undefined} />
          {busy ? 'Syncing' : 'Sync now'}
        </button>
      </div>
      <small className="muted" style={{ lineHeight: 1.5 }}>
        {note ??
          'Sends Health Connect (on Android), asks your connected apps for their latest, and updates your numbers. Pull down on any screen to do the same. Gauntlet also syncs on its own every 15 minutes.'}
      </small>
    </div>
  );
}

const useSourcePriority = () =>
  useQuery({
    queryKey: keys.sourcePriority,
    queryFn: () => get<SourcePriorityResponse>('/api/me/source-priority'),
  });

/** Per metric: which source counts when more than one reports it. */
export function SourcePriority() {
  const q = useSourcePriority();
  const qc = useQueryClient();
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function choose(metric: string, preferred: string | null) {
    setSaving(metric);
    setError(null);
    try {
      qc.setQueryData(
        keys.sourcePriority,
        await put('/api/me/source-priority', { metric, preferred }),
      );
      // Re-synced with the new choice: every screen's numbers may have moved.
      await qc.invalidateQueries();
      toast('Saved. Your numbers were updated.');
    } catch (err) {
      setError(err);
    } finally {
      setSaving(null);
    }
  }

  const metrics = q.data?.metrics.filter((m) => m.sources.length > 0) ?? [];
  return (
    <>
      <div className="lbl">Which source counts</div>
      <p className="muted" style={{ fontSize: 13, lineHeight: 1.5, margin: '0 0 10px' }}>
        When a watch and your phone both count the same thing, Gauntlet normally uses whichever
        reports more that day. Pick a source to use it first instead; days it has nothing still fall
        back to the others.
      </p>
      <ErrorBox error={q.error ?? error} />
      {q.isPending && <Skeleton height={160} />}
      {q.data && metrics.length === 0 && (
        <div className="card">
          <small className="muted">
            Nothing to choose yet. Once data arrives from more than one source, you can pick here.
          </small>
        </div>
      )}
      {metrics.length > 0 && (
        <div className="list">
          {metrics.map((m) => (
            <div key={m.key} className="item" style={{ alignItems: 'flex-start' }}>
              <div className="grow stack" style={{ gap: 8 }}>
                <div className="t">{m.label}</div>
                {m.sources.length < 2 ? (
                  <small className="muted">Only from {m.sources[0]!.label} so far.</small>
                ) : (
                  <div className="source-pick" role="group" aria-label={`${m.label} source`}>
                    <button
                      type="button"
                      aria-pressed={m.preferred == null}
                      disabled={saving === m.key}
                      onClick={() => m.preferred != null && void choose(m.key, null)}
                    >
                      Automatic
                    </button>
                    {m.sources.map((s) => (
                      <button
                        key={s.key}
                        type="button"
                        aria-pressed={m.preferred === s.key}
                        disabled={saving === m.key}
                        onClick={() => m.preferred !== s.key && void choose(m.key, s.key)}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
