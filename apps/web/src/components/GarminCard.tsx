import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { timeAgo } from '../lib/format';
import { keys, useGarmin } from '../lib/queries';
import { garmin } from '../lib/session';
import { Icon } from './Icon';
import { ErrorBox, Skeleton, toast } from './ui';

type Step = { kind: 'idle' } | { kind: 'form' } | { kind: 'code'; clientState: string };

/**
 * Connect Garmin Connect without leaving the app. SparkyFitness does the Garmin sign-in and keeps
 * the connection; this is just a nicer front for it.
 */
export function GarminCard() {
  const q = useGarmin();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const refresh = () => {
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

  async function connected() {
    setStep({ kind: 'idle' });
    setPassword('');
    setCode('');
    toast('Garmin connected. Your first sync takes a minute.');
    refresh();
  }

  async function submitLogin(e: FormEvent) {
    e.preventDefault();
    const res = await run(() => garmin.login(email, password));
    if (!res) return;
    if (res.status === 'needs_mfa') setStep({ kind: 'code', clientState: res.clientState });
    else await connected();
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (step.kind !== 'code') return;
    const res = await run(() => garmin.mfa(step.clientState, code));
    if (!res) return;
    if (res.status === 'connected') await connected();
  }

  async function syncNow() {
    if (await run(() => garmin.sync())) {
      toast('Syncing Garmin. New data shows up in a minute.');
      refresh();
    }
  }

  async function disconnect() {
    if (!window.confirm('Disconnect Garmin? Data already synced stays in SparkyFitness.')) return;
    if (await run(() => garmin.disconnect())) {
      toast('Garmin disconnected');
      refresh();
    }
  }

  const linked = q.data?.linked;
  const badge = (
    <div
      className="av"
      style={{ borderRadius: 12, width: 42, height: 42, color: 'var(--volt)', fontSize: 14 }}
    >
      G
    </div>
  );

  return (
    <>
      <div className="lbl">Garmin Connect</div>
      <ErrorBox error={error ?? (q.error && !q.data ? q.error : null)} />
      {q.isPending ? (
        <Skeleton height={64} />
      ) : linked ? (
        <div className="list">
          <div className="item">
            {badge}
            <div className="grow">
              <div className="t">Garmin Connect</div>
              <small>
                Connected
                {q.data?.lastUpdated ? ` · linked ${timeAgo(q.data.lastUpdated)}` : ''}
              </small>
            </div>
            <i className="dot" aria-label="Connected" />
          </div>
          <button className="item" onClick={syncNow} disabled={busy}>
            <div className="grow">
              <div className="t">Sync now</div>
              <small>Pulls the last week from Garmin</small>
            </div>
            {busy ? <span className="spinner" /> : <Icon name="refresh" size={18} />}
          </button>
          <button className="item" onClick={disconnect} disabled={busy}>
            <div className="grow">
              <div className="t" style={{ color: 'var(--danger)' }}>
                Disconnect Garmin
              </div>
            </div>
          </button>
        </div>
      ) : step.kind === 'idle' ? (
        <div className="list">
          <button className="item" onClick={() => setStep({ kind: 'form' })}>
            {badge}
            <div className="grow">
              <div className="t">Connect Garmin</div>
              <small>Steps, workouts, sleep and heart rate from your watch</small>
            </div>
            <Icon name="chevron" size={18} />
          </button>
        </div>
      ) : (
        <div className="card stack">
          {step.kind === 'form' ? (
            <form onSubmit={submitLogin} className="stack">
              <b style={{ fontSize: 16 }}>Sign in to Garmin Connect</b>
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
              <p className="muted" style={{ fontSize: 12, lineHeight: 1.45 }}>
                Your Garmin password goes straight to SparkyFitness to sign in. Gauntlet never
                stores it, and SparkyFitness keeps only a session token.
              </p>
              <button className="btn" disabled={busy}>
                {busy ? <span className="spinner" /> : 'Connect'}
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setStep({ kind: 'idle' });
                  setError(null);
                }}
              >
                Cancel
              </button>
            </form>
          ) : (
            <form onSubmit={submitCode} className="stack">
              <b style={{ fontSize: 16 }}>Enter your Garmin code</b>
              <p className="muted" style={{ fontSize: 13, lineHeight: 1.45 }}>
                Garmin sent a verification code to your email or authenticator app.
              </p>
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
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setStep({ kind: 'form' });
                  setError(null);
                }}
              >
                Start over
              </button>
            </form>
          )}
        </div>
      )}
    </>
  );
}
