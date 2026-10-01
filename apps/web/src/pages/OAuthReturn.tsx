import { isProviderId, type ProviderId } from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ErrorBox, Header, Screen, toast } from '../components/ui';
import { forgetOAuthStart, startedHere } from '../lib/oauth';
import { keys } from '../lib/queries';
import { connections } from '../lib/session';

const LABELS: Record<string, string> = {
  strava: 'Strava',
  fitbit: 'Fitbit',
  oura: 'Oura Ring',
  polar: 'Polar Flow',
  coros: 'COROS',
};

/**
 * Where an app's sign-in page sends the person back (SparkyFitness redirects here with a code).
 * It finishes the link, then returns to Data sources.
 */
export function OAuthReturnPage() {
  const params = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const id = isProviderId(params.provider) ? params.provider : null;
  const label = (id && LABELS[id]) ?? 'this app';
  const code = search.get('code');
  const state = search.get('state') ?? undefined;
  const denied = search.get('error');

  const [phase, setPhase] = useState<'checking' | 'confirm' | 'working' | 'error'>('checking');
  const [error, setError] = useState<unknown>(null);
  const started = useRef(false);

  async function finish(provider: ProviderId, authCode: string) {
    setPhase('working');
    try {
      await connections.finishOAuth(provider, authCode, state);
      await forgetOAuthStart();
      toast(`${label} connected. Your first sync takes a minute.`);
      void qc.invalidateQueries({ queryKey: keys.connections });
      void qc.invalidateQueries({ queryKey: keys.sources });
      navigate('/sources', { replace: true });
    } catch (err) {
      setError(err);
      setPhase('error');
    }
  }

  useEffect(() => {
    if (started.current || !id || !code || denied) return;
    started.current = true;
    // Only finish by itself if this device started the connection; a link someone else sent asks first.
    startedHere(id).then((mine) => (mine ? finish(id, code) : setPhase('confirm')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, code, denied]);

  if (!id || !code || denied)
    return (
      <Screen>
        <Header title="Connect" back="/sources" />
        <div className="card stack">
          <b style={{ fontSize: 17 }}>
            {denied ? `${label} didn't connect` : 'This link is missing something'}
          </b>
          <p className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
            {denied
              ? 'You cancelled, or the app said no. You can try again any time.'
              : 'Start from Data sources and tap the app you want to connect.'}
          </p>
          <Link to="/sources" className="btn">
            Back to Data sources
          </Link>
        </div>
      </Screen>
    );

  return (
    <Screen>
      <Header title={`Connect ${label}`} back="/sources" />
      <div className="card stack">
        {phase === 'confirm' ? (
          <>
            <b style={{ fontSize: 17 }}>Finish connecting {label}?</b>
            <p className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
              This links your {label} account to your Gauntlet account. Only continue if you just
              started this yourself.
            </p>
            <button className="btn" onClick={() => finish(id, code)}>
              Connect {label}
            </button>
            <Link to="/sources" className="btn ghost">
              Cancel
            </Link>
          </>
        ) : phase === 'error' ? (
          <>
            <ErrorBox error={error} />
            <Link to="/sources" className="btn">
              Back to Data sources
            </Link>
          </>
        ) : (
          <div className="row" style={{ gap: 12, alignItems: 'center' }}>
            <span className="spinner" /> <span>Connecting {label}…</span>
          </div>
        )}
      </div>
    </Screen>
  );
}
