import { COMMENT_MAX } from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import { ReactionRow } from '../components/Reactions';
import { Avatar, Empty, ErrorBox, Header, Screen, Skeleton, toast } from '../components/ui';
import { ApiError, del, post } from '../lib/api';
import { timeAgo } from '../lib/format';
import { keys } from '../lib/queries';
import { socialKeys, useComments, useFeedItem } from '../lib/social';
import '../styles/social.css';

/** One feed item with its reactions and comments. */
export function FeedItemPage() {
  const { eventId = '' } = useParams();
  const item = useFeedItem(eventId);
  const e = item.data;
  const gone = item.error instanceof ApiError && item.error.status === 404;

  return (
    <Screen>
      <Header title="Activity" back="/" />
      {gone ? (
        <div className="list">
          <Empty title="Not available">
            This activity is gone, or it's from someone you're not connected with.
          </Empty>
        </div>
      ) : (
        <ErrorBox error={item.error} />
      )}
      {item.isPending && <Skeleton height={120} />}
      {e && (
        <div className="stack" style={{ gap: 14 }}>
          <div className="card">
            <div className="row" style={{ gap: 12 }}>
              <Avatar user={e.actor} size={40} />
              <div className="grow">
                <div className="t" style={{ fontWeight: 600 }}>
                  {e.text}
                </div>
                <small className="muted">
                  {[e.challenge?.name, timeAgo(e.createdAt)].filter(Boolean).join(' · ')}
                </small>
              </div>
              {e.badge && <div className="v num">{e.badge}</div>}
            </div>
            <ReactionRow event={e} />
          </div>
          <Comments eventId={e.id} />
        </div>
      )}
    </Screen>
  );
}

function Comments({ eventId }: { eventId: string }) {
  const qc = useQueryClient();
  const q = useComments(eventId);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: socialKeys.comments(eventId) }),
      qc.invalidateQueries({ queryKey: socialKeys.item(eventId) }),
      qc.invalidateQueries({ queryKey: keys.feed }),
    ]);
  }

  async function add() {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    try {
      await post(`/api/feed/${eventId}/comments`, { body });
      setText('');
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await del(`/api/comments/${id}`);
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Something went wrong');
    }
  }

  return (
    <section>
      <div className="lbl">Comments</div>
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Skeleton height={60} />
      ) : q.data?.length ? (
        <div className="list" style={{ marginBottom: 12 }}>
          {q.data.map((c) => (
            <div key={c.id} className="comment">
              <Avatar user={c.user} size={32} />
              <div className="grow" style={{ minWidth: 0 }}>
                <small>
                  {c.user.displayName.split(' ')[0]} · {timeAgo(c.createdAt)}
                </small>
                <div className="body">{c.body}</div>
              </div>
              {c.canDelete && (
                <button
                  className="btn sm ghost"
                  aria-label={`Delete comment: ${c.body.slice(0, 30)}`}
                  onClick={() => remove(c.id)}
                >
                  Delete
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <small className="muted" style={{ display: 'block', marginBottom: 12 }}>
          No comments yet. Say something nice.
        </small>
      )}
      <form
        className="comment-form"
        onSubmit={(ev) => {
          ev.preventDefault();
          void add();
        }}
      >
        <textarea
          rows={2}
          value={text}
          maxLength={COMMENT_MAX}
          placeholder="Add a comment"
          aria-label="Add a comment"
          onChange={(ev) => setText(ev.target.value)}
        />
        <button className="btn sm" type="submit" disabled={busy || !text.trim()}>
          Post
        </button>
      </form>
    </section>
  );
}
