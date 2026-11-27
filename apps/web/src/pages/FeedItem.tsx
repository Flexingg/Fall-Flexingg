import { COMMENT_MAX } from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import { BadgeIcon } from '../components/BadgeIcon';
import { LevelChip } from '../components/LevelChip';
import { ReactionRow } from '../components/Reactions';
import { Avatar, Empty, ErrorBox, Header, Screen, toast } from '../components/ui';
import { SkeletonCard, SkeletonLine, SkeletonList } from '../components/Skeleton';
import { ApiError, del, post } from '../lib/api';
import { timeAgo } from '../lib/format';
import { keys } from '../lib/queries';
import { deferAction, usePendingUndo } from '../lib/undo';
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
      {item.isPending && (
        <SkeletonCard>
          <div className="row" style={{ gap: 12 }}>
            <SkeletonLine width={40} height={40} style={{ borderRadius: '50%' }} />
            <div className="grow stack" style={{ gap: 8 }}>
              <SkeletonLine width="60%" height={14} />
              <SkeletonLine width="35%" />
            </div>
          </div>
        </SkeletonCard>
      )}
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
                  <LevelChip level={e.actor.level} />
                  {[e.challenge?.name, timeAgo(e.createdAt)].filter(Boolean).join(' · ')}
                </small>
              </div>
              {e.badgeEarned ? (
                <BadgeIcon
                  icon={e.badgeEarned.icon}
                  imageUrl={e.badgeEarned.imageUrl}
                  medal={e.badgeEarned.tierName ?? 'single'}
                  size="lg"
                />
              ) : (
                e.badge && <div className="v num">{e.badge}</div>
              )}
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
  const waiting = usePendingUndo();

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

  // Deleting is instant and undoable for 5 s; the request goes out after that.
  function remove(id: string) {
    deferAction({
      key: `comment:${id}`,
      message: 'Comment deleted',
      commit: () => del(`/api/comments/${id}`),
      settle: (err) => {
        if (err) toast(err instanceof Error ? err.message : 'Something went wrong');
        void refresh();
      },
    });
  }

  return (
    <section>
      <div className="lbl">Comments</div>
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <SkeletonList rows={2} avatar={32} />
      ) : q.data?.some((c) => !waiting.has(`comment:${c.id}`)) ? (
        <div className="list" style={{ marginBottom: 12 }}>
          {q.data
            .filter((c) => !waiting.has(`comment:${c.id}`))
            .map((c) => (
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
