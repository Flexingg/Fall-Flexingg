import type { MeUser } from '@gauntlet/shared';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Icon } from '../components/Icon';
import { Avatar, ErrorBox, Header, Screen, toast } from '../components/ui';
import { del, patch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isNative } from '../lib/platform';
import { useAndroidRelease } from '../lib/queries';

export function MePage() {
  const { user, setUser, logout } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState(user?.displayName ?? '');
  const [error, setError] = useState<unknown>(null);
  const android = useAndroidRelease(!isNative);
  if (!user) return null;

  async function saveName() {
    if (!name.trim() || name.trim() === user!.displayName) return;
    try {
      setUser(await patch<MeUser>('/api/me', { displayName: name.trim() }));
      toast('Saved');
    } catch (err) {
      setError(err);
    }
  }

  async function deleteAccount() {
    if (!confirm('Delete your Gauntlet account? Your SparkyFitness data is not touched.')) return;
    try {
      await del('/api/me');
      await logout();
      navigate('/login');
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Screen>
      <Header title="Profile" back="/" />
      <div className="row" style={{ marginBottom: 18 }}>
        <Avatar user={user} size={64} me />
        <div className="grow">
          <div style={{ fontWeight: 800, fontSize: 20 }}>{user.displayName}</div>
          <div className="muted" style={{ fontSize: 14 }}>
            {user.email}
          </div>
        </div>
      </div>
      <ErrorBox error={error} />
      {user.sparkyKeyStatus !== 'active' && (
        <div className="error" style={{ marginBottom: 12 }}>
          Gauntlet lost access to SparkyFitness. Sign out and sign in again to reconnect.
        </div>
      )}
      <div className="lbl">Display name</div>
      <label className="input">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          maxLength={40}
          aria-label="Display name"
        />
        <span>Shown to friends</span>
      </label>

      <div className="lbl">Settings</div>
      <div className="list">
        <Link to="/sources" className="item">
          <Icon name="settings" size={20} />
          <div className="grow t">Data sources & privacy</div>
          <Icon name="chevron" size={18} />
        </Link>
        <div className="item">
          <Icon name="today" size={20} />
          <div className="grow">
            <div className="t">Time zone</div>
            <small>{user.timezone}</small>
          </div>
        </div>
      </div>

      {android.data && !isNative && (
        <>
          <div className="lbl">Android app</div>
          <div className="card stack" style={{ gap: 10 }}>
            <div className="row">
              <img
                src="/icons/favicon.svg"
                width={44}
                height={44}
                alt=""
                style={{ borderRadius: 11 }}
              />
              <div className="grow">
                <div className="t" style={{ fontWeight: 700 }}>
                  Gauntlet for Android
                </div>
                <small className="muted">
                  {android.data.version} · {(android.data.sizeBytes / 1048576).toFixed(1)} MB
                  {android.data.builtAt
                    ? ` · ${new Date(android.data.builtAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                    : ''}
                </small>
              </div>
            </div>
            <a className="btn" href={android.data.latestUrl} download>
              Download APK
            </a>
            <p className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
              Open the file on your phone and allow installs from your browser when asked. Updates
              install over the top and keep your data.
            </p>
          </div>
        </>
      )}

      <div className="stack" style={{ marginTop: 24 }}>
        <button
          className="btn secondary"
          onClick={async () => {
            await logout();
            navigate('/login');
          }}
        >
          Sign out
        </button>
        <button className="btn danger" onClick={deleteAccount}>
          Delete Gauntlet account
        </button>
      </div>
      <p className="muted center" style={{ fontSize: 12, marginTop: 18 }}>
        Gauntlet · powered by SparkyFitness
      </p>
    </Screen>
  );
}
