/**
 * Choose which Health Connect apps count, per stat (0.18). Several apps often write the same thing
 * (the phone's step counter, Fitbit and Garmin Connect all writing steps), so a person can say
 * "only listen to Garmin, then Fitbit". /sources/phone-apps lists the stats with more than one app;
 * /sources/phone-apps/:metric is the chooser for one. The choice is applied on the phone when it
 * next reads Health Connect, so the numbers only change after a sync.
 */
import {
  healthAppName,
  isHcOriginMetric,
  statMeta,
  type HcAppOrder,
  type HcAppSeen,
} from '@gauntlet/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Icon } from '../components/Icon';
import { ErrorBox, Header, Screen, Skeleton, Toggle } from '../components/ui';
import { useSyncNow } from '../lib/freshness';
import { useHcApps, useSaveHcApps } from '../lib/hcAppsQueries';
import { appLabel, capitalise, filterText } from '../lib/statSourceText';
import '../styles/sourceorder.css';
import '../styles/phoneApps.css';

const daysText = (n: number) => (n === 1 ? 'Seen 1 day' : `Seen ${n} days`);

/** What one stat is set to right now, in a few words. */
const currentText = (order: string[] | undefined, seen: HcAppSeen[]) =>
  order?.length
    ? `Only ${filterText(order, seen).replace('Counting ', '')}`
    : 'Health Connect decides';

/** The stats with two or more apps seen (or a choice already made), each linking to its chooser. */
export function PhoneAppsIndexPage() {
  const q = useHcApps();
  const rows = useMemo(() => {
    const d = q.data;
    if (!d) return [];
    return Object.keys({ ...d.seen, ...d.order })
      .filter((m) => statMeta(m) && ((d.seen[m]?.length ?? 0) >= 2 || d.order[m]?.length))
      .map((m) => ({
        metric: m,
        label: statMeta(m)!.label,
        seen: d.seen[m] ?? [],
        order: d.order[m],
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [q.data]);
  return (
    <Screen>
      <Header title="Phone apps" back="/sources" />
      <p className="muted pa-intro">
        More than one app on your phone can write the same stat to Health Connect, which can make a
        number too high. Pick a stat to choose which apps Gauntlet listens to.
      </p>
      <ErrorBox error={q.error} />
      {q.isPending && <Skeleton height={140} />}
      {q.data && rows.length === 0 && (
        <div className="card">
          <div style={{ fontWeight: 700 }}>No overlapping apps yet</div>
          <small className="muted">
            When two or more apps write the same stat to Health Connect, it shows up here after your
            next sync.
          </small>
        </div>
      )}
      {rows.length > 0 && (
        <div className="list" data-testid="phone-apps-index">
          {rows.map((r) => (
            <Link
              key={r.metric}
              to={`/sources/phone-apps/${encodeURIComponent(r.metric)}`}
              className="item"
              data-testid="phone-apps-row"
            >
              <div className="grow pa-main">
                <div className="t">{r.label}</div>
                <small>{currentText(r.order, r.seen)}</small>
              </div>
              <small className="pa-count">{r.seen.length} apps</small>
              <Icon name="chevron" size={18} />
            </Link>
          ))}
        </div>
      )}
    </Screen>
  );
}

interface Row {
  packageName: string;
  name: string;
  days: number | null;
  devices: string[];
  on: boolean;
}

/** The chooser for one stat. */
export function PhoneAppsPage() {
  const { metric = '' } = useParams();
  const meta = isHcOriginMetric(metric) ? statMeta(metric) : null;
  const q = useHcApps();
  const save = useSaveHcApps();
  const { busy, sync } = useSyncNow();
  const [custom, setCustom] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState(false);

  const savedList = q.data?.order[metric] ?? [];
  useEffect(() => {
    if (!q.data || ready) return;
    setCustom(savedList.length > 0);
    setPicked(savedList);
    setReady(true);
  }, [q.data, ready, savedList]);

  if (!meta)
    return (
      <Screen>
        <Header title="Phone apps" back="/sources/phone-apps" />
        <div className="card">That stat can't be changed here.</div>
      </Screen>
    );

  const seen = q.data?.seen[metric] ?? [];
  const nameOf = (pkg: string) => {
    const s = seen.find((a) => a.packageName === pkg);
    return appLabel(s?.name ?? healthAppName(pkg), pkg);
  };
  const rows: Row[] = [
    ...picked.map((pkg): Row => {
      const s = seen.find((a) => a.packageName === pkg);
      return {
        packageName: pkg,
        name: nameOf(pkg),
        days: s?.days ?? null,
        devices: s?.devices ?? [],
        on: true,
      };
    }),
    ...seen
      .filter((a) => !picked.includes(a.packageName))
      .map((a): Row => ({
        packageName: a.packageName,
        name: nameOf(a.packageName),
        days: a.days,
        devices: a.devices,
        on: false,
      })),
  ];

  const next = custom ? picked : [];
  const dirty = ready && next.join('\n') !== savedList.join('\n');
  const edit = (fn: () => void) => {
    setSaved(false);
    fn();
  };
  const toggle = (pkg: string, on: boolean) =>
    edit(() => setPicked((p) => (on ? [...p, pkg] : p.filter((x) => x !== pkg))));
  const move = (i: number, by: -1 | 1) =>
    edit(() =>
      setPicked((p) => {
        const n = [...p];
        [n[i], n[i + by]] = [n[i + by]!, n[i]!];
        return n;
      }),
    );
  async function onSave() {
    const order: HcAppOrder = { ...(q.data?.order ?? {}) };
    if (next.length) order[metric] = next;
    else delete order[metric];
    try {
      await save.mutateAsync(order);
      setSaved(true);
    } catch {
      /* shown by ErrorBox */
    }
  }

  return (
    <Screen>
      <Header title={`${meta.label}: phone apps`} back="/sources/phone-apps" />
      <p className="muted pa-intro">
        Choose which Health Connect apps Gauntlet listens to for {meta.label.toLowerCase()}.
      </p>
      <ErrorBox error={q.error ?? save.error} />
      {q.isPending && <Skeleton height={200} />}
      {ready && (
        <div className="stack" style={{ gap: 12 }}>
          <div className="source-pick" role="group" aria-label={`${meta.label} apps`}>
            <button
              type="button"
              aria-pressed={!custom}
              onClick={() => edit(() => setCustom(false))}
            >
              Health Connect decides (default)
            </button>
            <button type="button" aria-pressed={custom} onClick={() => edit(() => setCustom(true))}>
              Only these apps, in order
            </button>
          </div>
          <p className="muted pa-note">
            {custom
              ? `Each day, Gauntlet uses the first app on your list that has ${meta.label.toLowerCase()} for that day, and ignores the rest. Apps you leave off are ignored. If none of your apps has any, that day has nothing.`
              : `Health Connect adds up what your apps wrote and removes what it thinks is a copy. This is what happens until you choose apps.`}
          </p>

          {rows.length === 0 && (
            <div className="card">
              <small className="muted">
                No app has written {meta.label.toLowerCase()} to Health Connect in the last 30 days.
              </small>
            </div>
          )}
          {rows.length > 0 && (
            <ol className="order-list pa-list" data-testid="phone-apps-list">
              {rows.map((r) => {
                const i = picked.indexOf(r.packageName);
                return (
                  <li key={r.packageName} className={custom && r.on ? '' : 'pa-off'}>
                    {custom && (
                      <span className="order-rank" aria-hidden="true">
                        {r.on ? i + 1 : ''}
                      </span>
                    )}
                    <span className="pa-main grow">
                      <span className="pa-name">{r.name}</span>
                      {r.packageName !== r.name && (
                        <small className="pa-pkg" title={r.packageName}>
                          {r.packageName}
                        </small>
                      )}
                      <small>
                        {r.days == null ? 'Not seen in the last 30 days' : daysText(r.days)}
                        {r.devices.length > 0 && ` · ${r.devices.map(capitalise).join(', ')}`}
                      </small>
                    </span>
                    {custom && (
                      <>
                        {r.on && (
                          <>
                            <button
                              type="button"
                              className="order-btn"
                              aria-label={`Move ${r.name} up`}
                              disabled={i === 0}
                              onClick={() => move(i, -1)}
                            >
                              <Icon name="chevron" size={16} className="rot-up" />
                            </button>
                            <button
                              type="button"
                              className="order-btn"
                              aria-label={`Move ${r.name} down`}
                              disabled={i === picked.length - 1}
                              onClick={() => move(i, 1)}
                            >
                              <Icon name="chevron" size={16} className="rot-down" />
                            </button>
                          </>
                        )}
                        <Toggle
                          checked={r.on}
                          onChange={(on) => toggle(r.packageName, on)}
                          label={`Count ${r.name}`}
                        />
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {custom && picked.length === 0 && (
            <small className="muted">Switch on at least one app, or go back to the default.</small>
          )}

          <button
            className="btn"
            disabled={!dirty || save.isPending || (custom && picked.length === 0)}
            onClick={() => void onSave()}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>

          {saved && (
            <div className="card pa-saved" role="status" data-testid="phone-apps-saved">
              <div className="grow">
                <div style={{ fontWeight: 700 }}>Saved</div>
                <small className="muted">
                  Takes effect on your next sync. Your numbers change once your phone has read
                  Health Connect again.
                </small>
              </div>
              <button className="btn sm" disabled={busy} onClick={() => void sync()}>
                <Icon name="refresh" size={14} className={busy ? 'spin' : undefined} />
                {busy ? 'Syncing' : 'Sync now'}
              </button>
            </div>
          )}
        </div>
      )}
    </Screen>
  );
}
