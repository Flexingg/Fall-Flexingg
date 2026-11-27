import { useEffect, useState } from 'react';
import '../styles/hc16.css';
import { askHealthAccessAgain, healthAllowed, openHealthSettings } from '../lib/health';
import { accessRows, accessSummary } from '../lib/healthRecords';
import { isNative } from '../lib/platform';
import { Icon } from './Icon';

/**
 * Settings > Data sources > Health Connect: what Gauntlet is allowed to read, in plain words and
 * grouped, with a button to ask again and one to open Health Connect itself. Android only.
 */
export function HealthAccess() {
  const [allowed, setAllowed] = useState<string[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isNative) healthAllowed().then(setAllowed);
  }, []);

  if (!isNative) return null;
  const sum = allowed ? accessSummary(allowed) : null;

  async function askAgain() {
    setBusy(true);
    try {
      const now = await askHealthAccessAgain();
      setAllowed(now ?? (await healthAllowed()));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        className="item"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="hc-access"
      >
        <div className="grow">
          <div className="t">What Gauntlet can read</div>
          <small>
            {sum ? `${sum.allowed} of ${sum.total} kinds of data allowed` : 'Checking...'}
          </small>
        </div>
        <Icon name="chevron" size={18} />
      </button>
      {open && (
        <div className="item hc-access" id="hc-access">
          {allowed === null ? (
            <small className="muted">Health Connect didn't say. Open it to check.</small>
          ) : (
            accessRows(allowed).map((g) => (
              <section key={g.title}>
                <h4>{g.title}</h4>
                <ul>
                  {g.rows.map((r) => (
                    <li key={r.type} className={r.allowed ? 'on' : 'off'}>
                      <span aria-hidden>{r.allowed ? '✓' : '–'}</span> {r.label}
                      <span className="sr-only">{r.allowed ? ' allowed' : ' not allowed'}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
          <p className="muted">
            Anything not allowed is skipped. Gauntlet only reads, and passes it on to your
            SparkyFitness.
          </p>
          <div className="hc-actions">
            <button className="btn sm" onClick={askAgain} disabled={busy}>
              Ask again
            </button>
            <button className="btn sm secondary" onClick={() => openHealthSettings()}>
              Open Health Connect
            </button>
          </div>
        </div>
      )}
    </>
  );
}
