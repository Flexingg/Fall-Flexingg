import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { ErrorBox } from '../components/ui';
import { useAuth } from '../lib/auth';
import { DEFAULT_SERVER_URL, DEFAULT_SPARKY_URL } from '../lib/platform';

/**
 * Android sign-in. A SparkyFitness API key is all that's needed: the app then reads your data from
 * SparkyFitness itself. Entering a Gauntlet server as well turns on friends and challenges.
 */
export function DirectLoginPage() {
  const { loginDirect, notice } = useAuth();
  const navigate = useNavigate();
  const [sparkyUrl, setSparkyUrl] = useState(DEFAULT_SPARKY_URL);
  const [apiKey, setApiKey] = useState('');
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setStep(
      serverUrl.trim()
        ? 'Connecting to SparkyFitness and Gauntlet…'
        : 'Connecting to SparkyFitness…',
    );
    try {
      await loginDirect({ sparkyUrl, apiKey, serverUrl });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      setStep('');
    }
  }

  return (
    <main
      className="screen no-tabs"
      style={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh' }}
    >
      <div style={{ marginTop: '9vh', marginBottom: 24 }}>
        <img src="/icons/favicon.svg" width={64} height={64} alt="" style={{ borderRadius: 16 }} />
        <h1 style={{ fontSize: 40, fontWeight: 900, letterSpacing: '-0.03em', marginTop: 18 }}>
          Gauntlet
        </h1>
        <p className="muted" style={{ marginTop: 6, fontSize: 15, lineHeight: 1.45 }}>
          Your SparkyFitness data, scored. Connect with an API key. No other server needed.
        </p>
      </div>

      <form onSubmit={submit} className="stack">
        {notice && <div className="error">{notice}</div>}
        <label className="input">
          <input
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={sparkyUrl}
            onChange={(e) => setSparkyUrl(e.target.value)}
            placeholder="https://fit.example.com"
            required
            aria-label="SparkyFitness address"
          />
          <span>SparkyFitness</span>
        </label>
        <label className="input">
          <input
            type="password"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="API key"
            required
            minLength={32}
            aria-label="API key"
          />
        </label>
        <p className="muted" style={{ fontSize: 13, lineHeight: 1.45 }}>
          In SparkyFitness open Settings → API keys and create one. It works for Google sign-in
          accounts too. The key stays on this phone, in the Android Keystore.
        </p>

        <details className="card" style={{ padding: '12px 14px' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 14 }}>
            Friends &amp; challenges (optional)
          </summary>
          <p className="muted" style={{ fontSize: 13, lineHeight: 1.45, margin: '10px 0' }}>
            Competing needs a Gauntlet server to keep score between friends. Add its address to
            switch it on. Leave it empty to use Gauntlet on your own.
          </p>
          <label className="input">
            <input
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="https://gauntlet.example.com"
              aria-label="Gauntlet server address"
            />
          </label>
        </details>

        <ErrorBox error={error} />
        <button className="btn" disabled={busy}>
          {busy ? (
            <>
              <span className="spinner" /> {step}
            </>
          ) : (
            'Connect'
          )}
        </button>
      </form>
    </main>
  );
}
