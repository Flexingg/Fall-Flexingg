import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ErrorBox, Seg } from '../components/ui';
import { useAuth } from '../lib/auth';
import { DIRECT_AVAILABLE } from '../lib/platform';
import { DirectLoginPage } from './DirectLogin';

/** Android (and the opt-in test build) can talk to SparkyFitness directly; the web app always uses a Gauntlet server. */
export function LoginPage() {
  return DIRECT_AVAILABLE ? <DirectLoginPage /> : <ServerLoginPage />;
}

function ServerLoginPage() {
  const { login, verify } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const next = (location.state as { next?: string } | null)?.next ?? '/';
  const [method, setMethod] = useState<'password' | 'api_key'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = ticket
        ? await verify(ticket, code)
        : await login(method === 'password' ? { method, email, password } : { method, apiKey });
      if (res.status === 'two_factor') setTicket(res.ticket);
      else navigate(next, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      className="screen no-tabs"
      style={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh' }}
    >
      <div style={{ marginTop: '12vh', marginBottom: 28 }}>
        <img src="/icons/favicon.svg" width={64} height={64} alt="" style={{ borderRadius: 16 }} />
        <h1 style={{ fontSize: 40, fontWeight: 900, letterSpacing: '-0.03em', marginTop: 18 }}>
          Gauntlet
        </h1>
        <p className="muted" style={{ marginTop: 6, fontSize: 15, lineHeight: 1.45 }}>
          Throw down challenges with friends. Sign in with your SparkyFitness account.
        </p>
      </div>

      <form onSubmit={submit} className="stack">
        {ticket ? (
          <>
            <div className="notice">Enter the 6-digit code from your authenticator app.</div>
            <label className="input">
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
                aria-label="Code"
              />
            </label>
          </>
        ) : (
          <>
            <Seg
              label="Sign-in method"
              value={method}
              onChange={setMethod}
              options={[
                { value: 'password', label: 'Email & password' },
                { value: 'api_key', label: 'API key' },
              ]}
            />
            {method === 'password' ? (
              <>
                <label className="input">
                  <input
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    aria-label="Email"
                  />
                </label>
                <label className="input">
                  <input
                    type="password"
                    autoComplete="current-password"
                    placeholder="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    aria-label="Password"
                  />
                </label>
              </>
            ) : (
              <>
                <div className="notice">
                  Signed up with Google? Create an API key in SparkyFitness under Settings → API
                  keys and paste it here.
                </div>
                <label className="input">
                  <input
                    autoComplete="off"
                    placeholder="Paste API key"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    required
                    aria-label="API key"
                  />
                </label>
              </>
            )}
          </>
        )}
        <ErrorBox error={error} />
        <button className="btn" disabled={busy}>
          {busy ? <span className="spinner" /> : ticket ? 'Verify' : 'Sign in'}
        </button>
        {ticket && (
          <button type="button" className="btn ghost" onClick={() => setTicket(null)}>
            Start over
          </button>
        )}
      </form>
      <p
        className="muted center"
        style={{ fontSize: 12, marginTop: 'auto', paddingTop: 24, lineHeight: 1.5 }}
      >
        Gauntlet reads your SparkyFitness data to score challenges. Your friends only see challenge
        totals.
      </p>
    </main>
  );
}
