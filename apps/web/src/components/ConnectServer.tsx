import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../lib/auth';
import { DEFAULT_SERVER_URL } from '../lib/platform';
import { ErrorBox, Header, Screen } from './ui';

/** Shown in place of friends, challenges and invites when the app is talking to SparkyFitness only. */
export function ConnectServer({ what }: { what: string }) {
  const { connectServer } = useAuth();
  const navigate = useNavigate();
  const [url, setUrl] = useState(DEFAULT_SERVER_URL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await connectServer(url);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Header title={what} />
      <div className="card stack">
        <b style={{ fontSize: 17 }}>This needs a Gauntlet server</b>
        <p className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
          Right now Gauntlet is talking to SparkyFitness directly, which is all you need for Today,
          Trends and syncing. Keeping score between friends takes a Gauntlet server. Enter its
          address and you're signed in with the same API key.
        </p>
        <form onSubmit={submit} className="stack">
          <label className="input">
            <input
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://gauntlet.example.com"
              required
              aria-label="Gauntlet server address"
            />
          </label>
          <ErrorBox error={error} />
          <button className="btn" disabled={busy}>
            {busy ? <span className="spinner" /> : 'Connect server'}
          </button>
        </form>
      </div>
    </Screen>
  );
}
