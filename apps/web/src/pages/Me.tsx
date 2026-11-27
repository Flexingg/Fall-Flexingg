import type { MeUser } from '@gauntlet/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { DisplaySettings } from '../components/DisplaySettings';
import { Icon } from '../components/Icon';
import { LevelChip } from '../components/LevelChip';
import { Avatar, ErrorBox, Header, Screen, toast, Toggle } from '../components/ui';
import { del, patch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { loadVibration, setVibration } from '../lib/haptics';
import { isNative } from '../lib/platform';
import { fmtDate, fmtNum } from '../lib/format';
import { LegalLinks } from '../components/LegalLinks';
import { useAndroidRelease } from '../lib/queries';
import { AppUpdatesSection } from '../components/AppBanner';
import { canSelfUpdate } from '../lib/appUpdate';
import { useReviewList } from '../lib/reviewQueries';
import { monthName } from '@gauntlet/shared';

export function MePage() {
  const { user, setUser, logout, mode, disconnectServer } = useAuth();
  const direct = mode === 'direct';
  const navigate = useNavigate();
  const [name, setName] = useState(user?.displayName ?? '');
  const [handle, setHandle] = useState(user?.handle ?? '');
  useEffect(() => setHandle(user?.handle ?? ''), [user?.handle]);
  const [error, setError] = useState<unknown>(null);
  const android = useAndroidRelease(!isNative);
  const [vibration, setVibrationOn] = useState(true);
  useEffect(() => {
    if (isNative) void loadVibration().then(setVibrationOn);
  }, []);
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
    if (
      !confirm(
        'Delete your Gauntlet account? This removes your profile, scores and friends, and deletes challenges you created for everyone in them. Your SparkyFitness data is not touched. This cannot be undone.',
      )
    )
      return;
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
        {!direct && (
          <Link to={`/u/${user.id}`} className="item">
            <Icon name="trophy" size={20} />
            <div className="grow t">Your profile, trophies & stats</div>
            <Icon name="chevron" size={18} />
          </Link>
        )}
        {!direct && (
          <Link to="/badges" className="item">
            <Icon name="target" size={20} />
            <div className="grow t">Badges & level</div>
            <LevelChip level={user.level} />
            <Icon name="chevron" size={18} />
          </Link>
        )}
        {!direct && (
          <Link to="/me/notifications" className="item">
            <Icon name="bell" size={20} />
            <div className="grow t">Notifications</div>
            <Icon name="chevron" size={18} />
          </Link>
        )}
        <Link to="/sources" className="item">
          <Icon name="settings" size={20} />
          <div className="grow t">Data sources & privacy</div>
          <Icon name="chevron" size={18} />
        </Link>
        {user.isAdmin && !direct && (
          <Link to="/admin" className="item">
            <Icon name="pulse" size={20} />
            <div className="grow t">Server admin</div>
            <Icon name="chevron" size={18} />
          </Link>
        )}
        {isNative && (
          <Link to="/me/wallpaper" className="item">
            <Icon name="moon" size={20} />
            <div className="grow t">Live wallpaper</div>
            <Icon name="chevron" size={18} />
          </Link>
        )}
        {isNative && (
          <div className="item">
            <Icon name="pulse" size={20} />
            <div className="grow">
              <div className="t">Vibration</div>
              <small>A little buzz when you react, refresh or take the lead</small>
            </div>
            <Toggle
              checked={vibration}
              onChange={(on) => {
                setVibrationOn(on);
                void setVibration(on);
              }}
              label="Vibration"
            />
          </div>
        )}
        <div className="item">
          <Icon name="today" size={20} />
          <div className="grow">
            <div className="t">Time zone</div>
            <small>{user.timezone}</small>
          </div>
        </div>
      </div>

      <DisplaySettings />
      {!direct && <PastReviews />}

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
                  {android.data.version} · {fmtNum(android.data.sizeBytes / 1048576, 1)} MB
                  {android.data.builtAt ? ` · ${fmtDate(android.data.builtAt)}` : ''}
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

      {canSelfUpdate && <AppUpdatesSection />}

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
        {!direct && !user?.demo && (
          <button className="btn danger" onClick={deleteAccount}>
            Delete Gauntlet account
          </button>
        )}
      </div>
      <LegalLinks />
      <p className="muted center" style={{ fontSize: 12 }}>
        Gauntlet · powered by SparkyFitness
      </p>
    </Screen>
  );
}

/** Every month and year with something to look back on (the last year of months, then all years). */
function PastReviews() {
  const list = useReviewList();
  const [all, setAll] = useState(false);
  if (!list.data || (!list.data.months.length && !list.data.years.length)) return null;
  const months = all ? list.data.months : list.data.months.slice(0, 12);
  const row = (id: string, title: string) => (
    <Link key={id} to={`/review/${id}`} className="item">
      <Icon name="trends" size={20} />
      <div className="grow t">{title}</div>
      <Icon name="chevron" size={18} />
    </Link>
  );
  return (
    <>
      <div className="lbl">Looking back</div>
      <div className="list">
        {list.data.years.map((y) => row(y, `${y} in review`))}
        {months.map((m) => row(m, `${monthName(Number(m.slice(5)))} ${m.slice(0, 4)}`))}
        {list.data.months.length > 12 && (
          <button className="item" onClick={() => setAll((a) => !a)}>
            <div className="grow t muted">
              {all ? 'Show fewer' : `Show all ${list.data.months.length} months`}
            </div>
          </button>
        )}
      </div>
    </>
  );
}
