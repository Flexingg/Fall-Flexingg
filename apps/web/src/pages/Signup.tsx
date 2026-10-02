import { useState, type FormEvent } from 'react';
import { LegalLinks } from '../components/LegalLinks';
import { Link, useLocation, useNavigate } from 'react-router';
import { ErrorBox } from '../components/ui';
import { useAuth } from '../lib/auth';

/** Creates the SparkyFitness account behind the scenes and signs straight in. */
export function SignupPage() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const next = (location.state as { next?: string } | null)?.next ?? '/';
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signup({ name, email, password });
      navigate(next, { replace: true });
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
      <div style={{ marginTop: '9vh', marginBottom: 24 }}>
        <img src="/icons/favicon.svg" width={64} height={64} alt="" style={{ borderRadius: 16 }} />
        <h1 style={{ fontSize: 34, fontWeight: 900, letterSpacing: '-0.03em', marginTop: 18 }}>
          Create your account
        </h1>
        <p className="muted" style={{ marginTop: 6, fontSize: 15, lineHeight: 1.45 }}>
          Your activity is stored in SparkyFitness, which comes with Gauntlet. Friends only ever see
          challenge totals.
        </p>
      </div>

      <form onSubmit={submit} className="stack">
        <label className="input">
          <input
            autoComplete="name"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={60}
            aria-label="Name"
          />
        </label>
        <label className="input">
          <input
            type="email"
            autoComplete="email"
            autoCapitalize="none"
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
            autoComplete="new-password"
            placeholder="Password (8+ characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            aria-label="Password"
          />
        </label>
        <ErrorBox error={error} />
        <button className="btn" disabled={busy}>
          {busy ? <span className="spinner" /> : 'Create account'}
        </button>
        <Link to="/login" state={location.state} className="btn ghost">
          I already have an account
        </Link>
      </form>
      <p className="muted center" style={{ fontSize: 12, marginTop: 18 }}>
        By creating an account you agree to the terms and privacy policy.
      </p>
      <LegalLinks />
    </main>
  );
}
