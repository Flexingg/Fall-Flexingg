import {
  DEFAULT_PRIORITY_KEY,
  type SourceChoice,
  type SourcePriorityResponse,
} from '@gauntlet/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { get, put } from '../lib/api';
import { describeSync, useSyncNow } from '../lib/freshness';
import { timeAgo } from '../lib/format';
import { keys } from '../lib/queries';
import '../styles/sourceorder.css';
import { Icon } from './Icon';
import { ErrorBox, Skeleton, toast } from './ui';
import { invalidateSyncedData } from '../lib/syncedData';

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
          'Sends Health Connect (on Android), asks your connected apps for their last 7 days, and updates your numbers. Pull down on any screen to do the same. Gauntlet also syncs on its own every 15 minutes.'}
      </small>
    </div>
  );
}

const useSourcePriority = () =>
  useQuery({
    queryKey: keys.sourcePriority,
    queryFn: () => get<SourcePriorityResponse>('/api/me/source-priority'),
  });

/** The saved order first, then every other source, so the whole list can be shown and moved. */
function ranked(sources: SourceChoice[], order: string[]): SourceChoice[] {
  const byKey = new Map(sources.map((s) => [s.key, s]));
  const first = order.map((k) => byKey.get(k)).filter((s): s is SourceChoice => !!s);
  return [...first, ...sources.filter((s) => !order.includes(s.key))];
}

/** A ranked list with up and down buttons (no dragging, so it works with a keyboard and a screen reader). */
function OrderList({
  label,
  sources,
  disabled,
  onChange,
}: {
  label: string;
  sources: SourceChoice[];
  disabled: boolean;
  onChange: (order: string[]) => void;
}) {
  const move = (i: number, by: -1 | 1) => {
    const next = sources.map((s) => s.key);
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    onChange(next);
  };
  return (
    <ol className="order-list" aria-label={label}>
      {sources.map((s, i) => (
        <li key={s.key}>
          <span className="order-rank" aria-hidden="true">
            {i + 1}
          </span>
          <span className="grow">{s.label}</span>
          <button
            type="button"
            className="order-btn"
            aria-label={`Move ${s.label} up`}
            disabled={disabled || i === 0}
            onClick={() => move(i, -1)}
          >
            <Icon name="chevron" size={16} className="rot-up" />
          </button>
          <button
            type="button"
            className="order-btn"
            aria-label={`Move ${s.label} down`}
            disabled={disabled || i === sources.length - 1}
            onClick={() => move(i, 1)}
          >
            <Icon name="chevron" size={16} className="rot-down" />
          </button>
        </li>
      ))}
    </ol>
  );
}

/** Which source counts when more than one reports the same thing: a default order, and per-stat overrides. */
export function SourcePriority() {
  const q = useSourcePriority();
  const qc = useQueryClient();
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function save(metric: string, order: string[]) {
    setSaving(metric);
    setError(null);
    try {
      qc.setQueryData(keys.sourcePriority, await put('/api/me/source-priority', { metric, order }));
      // Re-synced with the new order: every screen's numbers may have moved.
      await invalidateSyncedData(qc);
      toast('Saved. Your numbers were updated.');
    } catch (err) {
      setError(err);
    } finally {
      setSaving(null);
    }
  }

  const d = q.data?.default;
  const custom = d && d.order.length > 0;
  return (
    <>
      <div className="lbl">Which source counts</div>
      <p className="muted" style={{ fontSize: 13, lineHeight: 1.5, margin: '0 0 10px' }}>
        When two sources count the same thing, Gauntlet uses the first one in this list that has a
        number for that day. Days none of them cover fall back to whatever has a number.
      </p>
      <ErrorBox error={q.error ?? error} />
      {q.isPending && <Skeleton height={160} />}
      {d && (
        <div className="card stack" style={{ gap: 10 }} aria-labelledby="default-order-title">
          <div id="default-order-title" style={{ fontWeight: 700 }}>
            Default order
          </div>
          <div className="source-pick" role="group" aria-label="Default order mode">
            <button
              type="button"
              aria-pressed={!custom}
              disabled={saving === DEFAULT_PRIORITY_KEY}
              onClick={() => custom && void save(DEFAULT_PRIORITY_KEY, [])}
            >
              Automatic (highest number)
            </button>
            <button
              type="button"
              aria-pressed={!!custom}
              disabled={saving === DEFAULT_PRIORITY_KEY}
              onClick={() =>
                !custom &&
                void save(
                  DEFAULT_PRIORITY_KEY,
                  d.sources.map((s) => s.key),
                )
              }
            >
              My order
            </button>
          </div>
          {custom && (
            <OrderList
              label="Default order of sources"
              sources={ranked(d.sources, d.order)}
              disabled={saving === DEFAULT_PRIORITY_KEY}
              onChange={(o) => void save(DEFAULT_PRIORITY_KEY, o)}
            />
          )}
          <small className="muted">
            Garmin, Fitbit and other connected apps, Health Connect on your phone, and numbers you
            type into SparkyFitness yourself.
          </small>
        </div>
      )}
      {q.data && (
        <div className="list" style={{ marginTop: 10 }}>
          {q.data.metrics.map((m) => {
            const own = m.order.length > 0;
            return (
              <div key={m.key} className="item" style={{ alignItems: 'flex-start' }}>
                <div className="grow stack" style={{ gap: 8 }}>
                  <div className="t">{m.label}</div>
                  <div className="source-pick" role="group" aria-label={`${m.label} source`}>
                    <button
                      type="button"
                      aria-pressed={!own}
                      disabled={saving === m.key}
                      onClick={() => own && void save(m.key, [])}
                    >
                      Same as default
                    </button>
                    <button
                      type="button"
                      aria-pressed={own}
                      disabled={saving === m.key}
                      onClick={() =>
                        !own &&
                        void save(
                          m.key,
                          m.sources.map((s) => s.key),
                        )
                      }
                    >
                      Custom order
                    </button>
                  </div>
                  {own && (
                    <OrderList
                      label={`${m.label} order of sources`}
                      sources={ranked(m.sources, m.order)}
                      disabled={saving === m.key}
                      onChange={(o) => void save(m.key, o)}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
