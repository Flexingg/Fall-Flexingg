import { ordinal, type Invite } from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { Avatar, Empty, ErrorBox, Header, Screen, Seg, Skeleton, toast } from '../components/ui';
import { ApiError, del, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { timeAgo } from '../lib/format';
import { useFriends, useUserSearch } from '../lib/queries';
import { shareLink } from '../lib/share';

export function FriendsPage() {
  const q = useFriends();
  const qc = useQueryClient();
  const { user } = useAuth();
  const [tab, setTab] = useState<'crew' | 'requests'>('crew');
  const [email, setEmail] = useState('');
  const term = useDebounced(email.trim(), 250);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(term);
  const search = useUserSearch(isEmail ? '' : term);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [invite, setInvite] = useState<Invite | null>(null);
  const incoming = q.data?.requests.filter((r) => r.direction === 'incoming') ?? [];
  const outgoing = q.data?.requests.filter((r) => r.direction === 'outgoing') ?? [];

  async function getInvite() {
    const inv = invite ?? (await post<Invite>('/api/invites', { kind: 'friend' }));
    setInvite(inv);
    return inv;
  }

  async function share() {
    try {
      const inv = await getInvite();
      const r = await shareLink(
        'Join me on Gauntlet',
        `${user?.displayName} wants to compete with you on Gauntlet.`,
        inv.url,
      );
      if (r === 'copied') toast('Invite link copied');
    } catch (err) {
      setError(err);
    }
  }

  async function request(body: { email: string } | { userId: string }) {
    setError(null);
    try {
      const r = await post<{ status: string }>('/api/friends/requests', body);
      toast(r.status === 'friends' ? "You're now friends" : 'Request sent');
      await qc.invalidateQueries();
    } catch (err) {
      setError(err);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!isEmail) return;
    setError(null);
    try {
      const r = await post<{ status: string }>('/api/friends/requests', { email: term });
      toast(r.status === 'friends' ? "You're now friends" : 'Request sent');
      setEmail('');
      setAdding(false);
      await qc.invalidateQueries();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'not_on_gauntlet') {
        setError(err);
        return;
      }
      setError(err);
    }
  }

  async function respond(userId: string, accept: boolean) {
    try {
      if (accept) await post(`/api/friends/requests/${userId}/accept`);
      else await del(`/api/friends/${userId}`);
      await qc.invalidateQueries();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Screen>
      <Header
        title="Friends"
        action={
          <button
            className="av lead"
            style={{ width: 36, height: 36 }}
            onClick={() => setAdding((a) => !a)}
            aria-label="Add friend"
            aria-expanded={adding}
          >
            <Icon name={adding ? 'close' : 'plus'} size={20} strokeWidth={2.5} />
          </button>
        }
      />
      {adding && (
        <form onSubmit={add} className="stack" style={{ marginBottom: 14 }}>
          <label className="input">
            <input
              type="search"
              placeholder="Name, @handle or email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              autoCapitalize="none"
              aria-label="Find people"
            />
            {isEmail && (
              <button className="btn sm" style={{ width: 'auto' }}>
                Add
              </button>
            )}
          </label>
          {!isEmail && term.length >= 2 && (
            <div className="list" aria-label="Search results">
              {search.isPending && <Skeleton height={56} />}
              {search.data?.length === 0 && (
                <Empty title="Nobody found">
                  Only people with a public profile show up. Try their email, or share your invite
                  link.
                </Empty>
              )}
              {search.data?.map((p) => (
                <div key={p.id} className="item">
                  <Avatar user={p} size={42} />
                  <div className="grow">
                    <div className="t">{p.displayName}</div>
                    <small className="ellipsis">
                      {p.handle ? `@${p.handle} · ` : ''}
                      {p.challenges.played
                        ? `${p.challenges.won} won of ${p.challenges.played}`
                        : 'No finished challenges yet'}
                    </small>
                  </div>
                  {p.friendship === 'none' || p.friendship === 'incoming' ? (
                    <button
                      type="button"
                      className="btn sm"
                      style={{ width: 'auto' }}
                      onClick={() => request({ userId: p.id })}
                    >
                      {p.friendship === 'incoming' ? 'Accept' : 'Add'}
                    </button>
                  ) : (
                    <span className="pill plain">
                      {p.friendship === 'friends'
                        ? 'Friends'
                        : p.friendship === 'me'
                          ? 'You'
                          : 'Requested'}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </form>
      )}
      <Seg
        label="Show"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'crew', label: `Crew · ${q.data?.friends.length ?? 0}` },
          { value: 'requests', label: `Requests · ${incoming.length}` },
        ]}
      />
      <div style={{ height: 14 }} />
      <ErrorBox error={q.error ?? error} />
      {q.isPending && <Skeleton height={300} />}

      {q.data &&
        tab === 'crew' &&
        (q.data.friends.length ? (
          <div className="list">
            {q.data.friends.map((f) => (
              <div key={f.id} className="item">
                <Avatar user={f} size={42} />
                <div className="grow">
                  <div className="t">{f.displayName}</div>
                  <small className="ellipsis">
                    {f.status ?? `Synced ${timeAgo(f.lastSyncedAt)}`}
                  </small>
                </div>
                {f.sharedRank && <span className="pill">{ordinal(f.sharedRank)}</span>}
                <i
                  className={`dot${f.online ? '' : ' off'}`}
                  aria-label={f.online ? 'Recently active' : 'Inactive'}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="list">
            <Empty title="No crew yet">
              Share your invite link. Anyone who joins with it becomes your friend.
            </Empty>
          </div>
        ))}

      {q.data && tab === 'requests' && (
        <div className="list">
          {incoming.length === 0 && outgoing.length === 0 && <Empty title="No requests" />}
          {incoming.map((r) => (
            <div key={r.id} className="item">
              <Avatar user={r.user} size={42} />
              <div className="grow">
                <div className="t">{r.user.displayName}</div>
                <small>Wants to be friends</small>
              </div>
              <button className="btn sm" onClick={() => respond(r.user.id, true)}>
                Accept
              </button>
              <button
                className="btn sm secondary"
                onClick={() => respond(r.user.id, false)}
                aria-label="Decline"
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
          {outgoing.map((r) => (
            <div key={r.id} className="item">
              <Avatar user={r.user} size={42} />
              <div className="grow">
                <div className="t">{r.user.displayName}</div>
                <small>Request sent</small>
              </div>
              <button className="btn sm secondary" onClick={() => respond(r.user.id, false)}>
                Cancel
              </button>
            </div>
          ))}
        </div>
      )}

      <button className="hero" style={{ marginTop: 14 }} onClick={share}>
        <div className="badge">
          <Icon name="share" />
        </div>
        <div className="grow">
          <small>Invite link</small>
          <b className="ellipsis">
            {invite ? invite.url.replace(/^https?:\/\//, '') : 'Share your invite'}
          </b>
        </div>
      </button>
    </Screen>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
