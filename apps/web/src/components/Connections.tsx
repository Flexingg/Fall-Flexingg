import { isProviderId, type ConnectionInfo, type ProviderId } from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { timeAgo } from '../lib/format';
import { openSignIn, rememberOAuthStart } from '../lib/oauth';
import { keys, useConnections } from '../lib/queries';
import { connections, garmin } from '../lib/session';
import { Icon } from './Icon';
import { ErrorBox, Skeleton, toast } from './ui';

/** Where a person finds the key to paste. */
const KEY_HELP: Partial<Record<ProviderId, string>> = {
  hevy: 'In the Hevy app: Settings → Developer → API key. It needs Hevy Pro.',
  liftosaur: 'In the Liftosaur app: Settings → API Keys. It needs a Liftosaur subscription.',
};

type GarminStep = { kind: 'form' } | { kind: 'code'; clientState: string };

/**
 * Link apps and devices without leaving Gauntlet. SparkyFitness does the signing in, keeps the
 * connection and stores the data; this is a friendlier front for it.
 */
export function Connections() {
  const q = useConnections();
  const qc = useQueryClient();
  const { hash } = useLocation();
  const [open, setOpen] = useState<ProviderId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // /sources#garmin (from the Today screen's "connect a source" card) opens that app's row.
  const target = hash.slice(1);
  const loaded = !!q.data;
  useEffect(() => {
    if (!loaded || !isProviderId(target)) return;
    setOpen(target);
    document.getElementById(`app-${target}`)?.scrollIntoView({ block: 'center' });
  }, [loaded, target]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.connections });
    void qc.invalidateQueries({ queryKey: keys.garmin });
    void qc.invalidateQueries({ queryKey: keys.sources });
    // The first pull runs in the background; look again a little later.
    for (const ms of [8_000, 25_000, 60_000])
      setTimeout(() => {
        void qc.invalidateQueries({ queryKey: keys.sources });
        void qc.invalidateQueries({ queryKey: keys.today });
      }, ms);
  };

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  const done = (label: string) => {
    setOpen(null);
    toast(`${label} connected. Your first sync takes a minute.`);
    refresh();
  };

  return (
    <>
      <div className="lbl">Apps &amp; devices</div>
      <ErrorBox error={error ?? (q.error && !q.data ? q.error : null)} />
      {q.isPending ? (
        <Skeleton height={200} />
      ) : (
        <div className="list">
          {q.data?.map((c) => (
            <div key={c.id} id={`app-${c.id}`}>
              <button
                className="item"
                style={{ width: '100%' }}
                onClick={() => {
                  setError(null);
                  setOpen(open === c.id ? null : c.id);
                }}
                aria-expanded={open === c.id}
              >
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
                  {c.label[0]}
                </div>
                <div className="grow">
                  <div className="t">{c.label}</div>
                  <small>
                    {c.state === 'connected'
                      ? `Connected${c.lastSyncAt ? ` · synced ${timeAgo(c.lastSyncAt)}` : ''}`
                      : c.state === 'unavailable'
                        ? 'Not available here'
                        : c.blurb}
                  </small>
                </div>
                {c.state === 'connected' ? (
                  <i className="dot" aria-label="Connected" />
                ) : (
                  <Icon name={open === c.id ? 'close' : 'chevron'} size={18} />
                )}
              </button>
              {open === c.id && (
                <div className="card stack" style={{ margin: '6px 0 10px' }}>
                  <Panel
                    c={c}
                    busy={busy}
                    run={run}
                    onConnected={() => done(c.label)}
                    onChanged={refresh}
                    setError={setError}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

interface PanelProps {
  c: ConnectionInfo;
  busy: boolean;
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  onConnected: () => void;
  onChanged: () => void;
  setError: (e: unknown) => void;
}

function Panel(p: PanelProps) {
  const { c } = p;
  if (c.state === 'connected') return <ConnectedPanel {...p} />;
  if (c.state === 'unavailable') return <UnavailablePanel c={c} />;
  if (c.kind === 'login') return <GarminForm {...p} />;
  if (c.kind === 'oauth') return <OAuthPanel {...p} />;
  if (c.kind === 'api_key') return <KeyPanel {...p} />;
  return <LibraryPanel {...p} />;
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="muted" style={{ fontSize: 13, lineHeight: 1.45 }}>
      {children}
    </p>
  );
}

function UnavailablePanel({ c }: { c: ConnectionInfo }) {
  return (
    <>
      <b style={{ fontSize: 16 }}>{c.label}</b>
      <Note>{c.note}</Note>
      {c.settingsUrl && (
        <a className="btn secondary" href={c.settingsUrl} target="_blank" rel="noreferrer">
          Open SparkyFitness
        </a>
      )}
    </>
  );
}

function ConnectedPanel({ c, busy, run, onChanged }: PanelProps) {
  const canSync = c.kind !== 'library';
  return (
    <>
      <b style={{ fontSize: 16 }}>{c.label} is connected</b>
      <Note>
        {c.kind === 'library'
          ? 'SparkyFitness can search this exercise library when you log workouts there.'
          : 'SparkyFitness syncs it about once an hour. New data shows up in Today and your challenges.'}
      </Note>
      {canSync && (
        <button
          className="btn secondary"
          disabled={busy}
          onClick={async () => {
            if (await run(() => connections.sync(c.id))) {
              toast(`Syncing ${c.label}. New data shows up in a minute.`);
              onChanged();
            }
          }}
        >
          {busy ? <span className="spinner" /> : 'Sync now'}
        </button>
      )}
      <button
        className="btn danger"
        disabled={busy}
        onClick={async () => {
          const what =
            c.kind === 'api_key'
              ? 'Disconnect? Your key is removed from SparkyFitness. Data already synced stays.'
              : `Disconnect ${c.label}? Data already synced stays in SparkyFitness.`;
          if (!window.confirm(what)) return;
          if (await run(() => connections.disconnect(c.id))) {
            toast(`${c.label} disconnected`);
            onChanged();
          }
        }}
      >
        Disconnect
      </button>
    </>
  );
}

function OAuthPanel({ c, busy, run }: PanelProps) {
  return (
    <>
      <b style={{ fontSize: 16 }}>Connect {c.label}</b>
      <Note>
        You'll sign in on {c.label}'s own page and allow Gauntlet's SparkyFitness to read your
        activity. Gauntlet never sees your {c.label} password.
      </Note>
      <button
        className="btn"
        disabled={busy}
        onClick={async () => {
          const res = await run(() => connections.connect(c.id));
          if (res?.status === 'redirect') {
            await rememberOAuthStart(c.id);
            openSignIn(res.url);
          }
        }}
      >
        {busy ? <span className="spinner" /> : `Continue to ${c.label}`}
      </button>
    </>
  );
}

function KeyPanel({ c, busy, run, onConnected }: PanelProps) {
  const [apiKey, setApiKey] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if ((await run(() => connections.connect(c.id, apiKey)))?.status === 'connected') {
      setApiKey('');
      onConnected();
    }
  }
  return (
    <form onSubmit={submit} className="stack">
      <b style={{ fontSize: 16 }}>Connect {c.label}</b>
      <Note>{KEY_HELP[c.id]}</Note>
      <label className="input">
        <input
          type="password"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={`${c.label} API key`}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          required
          aria-label={`${c.label} API key`}
        />
      </label>
      <Note>
        The key is kept in SparkyFitness so it can sync for you. Gauntlet doesn't store it.
      </Note>
      <button className="btn" disabled={busy}>
        {busy ? <span className="spinner" /> : 'Connect'}
      </button>
    </form>
  );
}

function LibraryPanel({ c, busy, run, onConnected }: PanelProps) {
  return (
    <>
      <b style={{ fontSize: 16 }}>{c.label}</b>
      <Note>{c.blurb}</Note>
      <button
        className="btn"
        disabled={busy}
        onClick={async () => {
          if (await run(() => connections.connect(c.id))) onConnected();
        }}
      >
        {busy ? <span className="spinner" /> : `Switch on ${c.label}`}
      </button>
    </>
  );
}

function GarminForm({ busy, run, onConnected, c }: PanelProps) {
  const [step, setStep] = useState<GarminStep>({ kind: 'form' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');

  async function submitLogin(e: FormEvent) {
    e.preventDefault();
    const res = await run(() => garmin.login(email, password));
    if (!res) return;
    if (res.status === 'needs_mfa') setStep({ kind: 'code', clientState: res.clientState });
    else {
      setPassword('');
      onConnected();
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (step.kind !== 'code') return;
    if ((await run(() => garmin.mfa(step.clientState, code)))?.status === 'connected') {
      setCode('');
      setPassword('');
      onConnected();
    }
  }

  return step.kind === 'form' ? (
    <form onSubmit={submitLogin} className="stack">
      <b style={{ fontSize: 16 }}>Sign in to {c.label}</b>
      <label className="input">
        <input
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          placeholder="Garmin email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          aria-label="Garmin email"
        />
      </label>
      <label className="input">
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Garmin password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          aria-label="Garmin password"
        />
      </label>
      <Note>
        Your Garmin password goes straight to SparkyFitness to sign in. Gauntlet never stores it,
        and SparkyFitness keeps only a session token.
      </Note>
      <button className="btn" disabled={busy}>
        {busy ? <span className="spinner" /> : 'Connect'}
      </button>
    </form>
  ) : (
    <form onSubmit={submitCode} className="stack">
      <b style={{ fontSize: 16 }}>Enter your Garmin code</b>
      <Note>Garmin sent a verification code to your email or authenticator app.</Note>
      <label className="input">
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
          autoFocus
          aria-label="Garmin code"
        />
      </label>
      <button className="btn" disabled={busy}>
        {busy ? <span className="spinner" /> : 'Verify'}
      </button>
      <button type="button" className="btn ghost" onClick={() => setStep({ kind: 'form' })}>
        Start over
      </button>
    </form>
  );
}
