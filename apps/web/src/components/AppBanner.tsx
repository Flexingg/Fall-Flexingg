import { App as CapApp } from '@capacitor/app';
import type { AndroidRelease } from '@gauntlet/shared';
import { useEffect, useState } from 'react';
import {
  canSelfUpdate,
  checkForUpdate,
  fetchLatestRelease,
  InstallPermissionNeeded,
  installUpdate,
  isAndroidBrowser,
} from '../lib/appUpdate';
import { storage } from '../lib/storage';
import { Icon } from './Icon';

const DISMISS_KEY = 'gauntlet.appBanner.dismissed';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * One floating card for the Android app:
 *  - in an Android phone's browser: "Get the app", downloading the newest APK;
 *  - in the installed app: "Update available" when the server has a newer release.
 * "Not now" hides it until the next release.
 */
export function AppBanner() {
  const [release, setRelease] = useState<AndroidRelease | null>(null);
  const [dismissed, setDismissed] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    storage.get(DISMISS_KEY).then(setDismissed, () => setDismissed(null));
  }, []);

  useEffect(() => {
    if (isAndroidBrowser) {
      fetchLatestRelease().then(setRelease, () => undefined);
      return;
    }
    if (!canSelfUpdate) return;
    let last = 0;
    const run = () => {
      if (Date.now() - last < CHECK_EVERY_MS) return;
      last = Date.now();
      checkForUpdate().then(
        (c) => setRelease(c.available ? c.latest : null),
        () => undefined,
      );
    };
    run();
    const sub = CapApp.addListener('resume', run);
    return () => {
      sub.then((h) => h.remove());
    };
  }, []);

  if (!release || dismissed === undefined || dismissed === release.version) return null;
  const hide = () => {
    setDismissed(release.version);
    void storage.set(DISMISS_KEY, release.version);
  };
  return canSelfUpdate ? (
    <UpdateCard release={release} onLater={hide} />
  ) : (
    <GetAppCard release={release} onLater={hide} />
  );
}

function Shell({
  title,
  sub,
  onLater,
  children,
}: {
  title: string;
  sub: string;
  onLater: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="app-banner card" role="region" aria-label={title}>
      <div className="row" style={{ gap: 12 }}>
        <img src="/icons/favicon.svg" width={40} height={40} alt="" style={{ borderRadius: 10 }} />
        <div className="grow">
          <div style={{ fontWeight: 800 }}>{title}</div>
          <small className="muted">{sub}</small>
        </div>
        <button type="button" className="app-banner-x" aria-label="Not now" onClick={onLater}>
          <Icon name="close" size={18} />
        </button>
      </div>
      {children}
    </div>
  );
}

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

function GetAppCard({ release, onLater }: { release: AndroidRelease; onLater: () => void }) {
  return (
    <Shell
      title="Get the Gauntlet app"
      sub={`Android · ${release.version}${release.sizeBytes ? ` · ${mb(release.sizeBytes)}` : ''}`}
      onLater={onLater}
    >
      <a className="btn" href={release.latestUrl} download>
        Download app
      </a>
      <small className="muted" style={{ lineHeight: 1.5 }}>
        Open the downloaded file and allow installs from your browser when asked. Health Connect
        sync and the live wallpaper need the app.
      </small>
    </Shell>
  );
}

function UpdateCard({ release, onLater }: { release: AndroidRelease; onLater: () => void }) {
  return (
    <Shell
      title="Update available"
      sub={`Gauntlet ${release.version}${release.sizeBytes ? ` · ${mb(release.sizeBytes)}` : ''}`}
      onLater={onLater}
    >
      <UpdateButton release={release} />
    </Shell>
  );
}

/** Downloads the release and opens Android's installer, showing progress and what to do next. */
function UpdateButton({ release }: { release: AndroidRelease }) {
  const [progress, setProgress] = useState<number | null | undefined>(undefined);
  const [message, setMessage] = useState<string | null>(null);
  const busy = progress !== undefined;

  async function update() {
    setMessage(null);
    setProgress(null);
    try {
      await installUpdate(release, setProgress);
      setMessage('Follow Android’s prompt to finish. Your data stays.');
    } catch (err) {
      setMessage(
        err instanceof InstallPermissionNeeded
          ? err.message
          : err instanceof Error
            ? err.message
            : 'The update failed. Try again.',
      );
    } finally {
      setProgress(undefined);
    }
  }

  return (
    <>
      <button type="button" className="btn" disabled={busy} onClick={update}>
        {busy
          ? progress == null
            ? 'Downloading…'
            : `Downloading… ${Math.round(progress * 100)}%`
          : `Update to ${release.version}`}
      </button>
      {message && (
        <small className="muted" role="status" style={{ lineHeight: 1.5 }}>
          {message}
        </small>
      )}
    </>
  );
}

/** Me page (installed app only): the installed version and a manual "Check for updates". */
export function AppUpdatesSection() {
  const [installed, setInstalled] = useState<string | null>(null);
  const [state, setState] = useState<
    | { kind: 'idle' | 'checking' | 'current' }
    | { kind: 'available'; release: AndroidRelease }
    | { kind: 'error'; msg: string }
  >({ kind: 'idle' });

  useEffect(() => {
    CapApp.getInfo().then(
      (i) => setInstalled(i.version),
      () => undefined,
    );
  }, []);

  async function check() {
    setState({ kind: 'checking' });
    try {
      const c = await checkForUpdate();
      setInstalled(c.installed);
      if (c.available && c.latest) setState({ kind: 'available', release: c.latest });
      else if (!c.latest)
        setState({ kind: 'error', msg: 'This server has no Android release to offer yet.' });
      else setState({ kind: 'current' });
    } catch (err) {
      setState({ kind: 'error', msg: err instanceof Error ? err.message : 'Checking failed.' });
    }
  }

  return (
    <>
      <div className="lbl">App updates</div>
      <div className="card stack" style={{ gap: 10 }}>
        <div className="row">
          <div className="grow">
            <div style={{ fontWeight: 700 }}>
              Gauntlet {installed ? `v${installed.replace(/^v/, '')}` : ''}
            </div>
            <small className="muted">
              {state.kind === 'current'
                ? 'You have the latest version.'
                : state.kind === 'available'
                  ? `${state.release.version} is available.`
                  : state.kind === 'error'
                    ? state.msg
                    : 'Updates come from your Gauntlet server.'}
            </small>
          </div>
          {state.kind !== 'available' && (
            <button
              type="button"
              className="btn sm secondary"
              disabled={state.kind === 'checking'}
              onClick={check}
            >
              {state.kind === 'checking' ? 'Checking…' : 'Check for updates'}
            </button>
          )}
        </div>
        {state.kind === 'available' && <UpdateButton release={state.release} />}
      </div>
    </>
  );
}
