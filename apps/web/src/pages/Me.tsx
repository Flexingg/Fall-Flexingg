import type { MeUser } from '@gauntlet/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Icon } from '../components/Icon';
import { Avatar, ErrorBox, Header, Screen, toast, Toggle } from '../components/ui';
import { del, patch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isNative } from '../lib/platform';
import { useAndroidRelease } from '../lib/queries';

export function MePage() {
  const { user, setUser, logout, mode, disconnectServer } = useAuth();
  const direct = mode === 'direct';
  const navigate = useNavigate();
  const [name, setName] = useState(user?.displayName ?? '');
  const [handle, setHandle] = useState(user?.handle ?? '');
  useEffect(() => setHandle(user?.handle ?? ''), [user?.handle]);
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

  async function save(body: Record<string, unknown>, done = 'Saved') {
    setError(null);
    try {
      setUser(await patch<MeUser>('/api/me', body));
      toast(done);
    } catch (err) {
      setError(err);
    }
  }

  async function saveHandle() {
    const h = handle.trim().replace(/^@/, '').toLowerCase();
    if (h === (user!.handle ?? '')) return;
    await save({ handle: h });
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
            {user.handle ? `@${user.handle} · ` : ''}
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
      {direct ? (
        <p className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
          Connected straight to SparkyFitness. Your name comes from your SparkyFitness account.
        </p>
      ) : (
        <>
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

          <div className="lbl">Profile</div>
          <div className="card stack" style={{ gap: 10 }}>
            <div className="row">
              <div className="grow">
                <div style={{ fontWeight: 700 }}>Public profile</div>
                <small className="muted">
                  {user.visibility === 'public'
                    ? 'Anyone on this server can find you and see your name and challenge record.'
                    : 'Only friends and people in your challenges can see you.'}
                </small>
              </div>
              <Toggle
                checked={user.visibility === 'public'}
                onChange={(on) =>
                  save(
                    { visibility: on ? 'public' : 'private' },
                    on ? "You're public" : "You're private",
                  )
                }
                label="Public profile"
              />
            </div>
            <p className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
              Going public lets people search for you by name and lets you join public challenges
              from Discover. Your email and health data are never shown.
            </p>
            {user.visibility === 'public' && (
              <label className="input">
                <input
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  onBlur={saveHandle}
                  placeholder="@handle"
                  maxLength={21}
                  autoCapitalize="none"
                  aria-label="Handle"
                />
                <span>Optional, for search</span>
              </label>
            )}
          </div>
        </>
      )}

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

      {isNative && (
        <>
          <div className="lbl">Gauntlet server</div>
          <div className="card stack" style={{ gap: 10 }}>
            {direct ? (
              <>
                <b>Not connected</b>
                <p className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
                  Friends, challenges and the activity feed need a Gauntlet server.
                </p>
                <Link to="/challenges" className="btn secondary">
                  Connect a server
                </Link>
              </>
            ) : (
              <>
                <b>Connected</b>
                <p className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
                  Your data is read through your Gauntlet server. Disconnect to use SparkyFitness
                  directly on this phone.
                </p>
                <button
                  className="btn secondary"
                  onClick={() =>
                    disconnectServer()
                      .then(() => navigate('/'))
                      .catch(setError)
                  }
                >
                  Disconnect server
                </button>
              </>
            )}
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
        {!direct && (
          <button className="btn danger" onClick={deleteAccount}>
            Delete Gauntlet account
          </button>
        )}
      </div>
      <p className="muted center" style={{ fontSize: 12, marginTop: 18 }}>
        Gauntlet · powered by SparkyFitness
      </p>
    </Screen>
  );
}
