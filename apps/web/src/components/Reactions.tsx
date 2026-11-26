import { REACTIONS, type FeedEvent } from '@gauntlet/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { tap } from '../lib/haptics';
import { useToggleReaction } from '../lib/social';
import '../styles/social.css';
import { toast } from './ui';

/** Existing reactions as chips, a "+" to add one, and the comment count linking to the item. */
export function ReactionRow({ event }: { event: FeedEvent }) {
  const toggle = useToggleReaction();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // The on-device (direct) feed has no reactions to show.
  if (!event.reactions) return null;
  const mineSet = new Set(event.reactions.filter((r) => r.mine).map((r) => r.emoji));

  async function press(emoji: string, mine: boolean) {
    tap();
    setBusy(true);
    setOpen(false);
    try {
      await toggle(event.id, emoji, mine);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const comments = event.commentCount ?? 0;
  return (
    <div className="rx-row">
      {event.reactions.map((r) => (
        <button
          key={r.emoji}
          className={`rx-chip${r.mine ? ' mine' : ''}`}
          disabled={busy}
          aria-pressed={r.mine}
          aria-label={`${r.emoji} ${r.count}${r.mine ? ', you reacted' : ''}`}
          onClick={() => press(r.emoji, r.mine)}
        >
          <span>{r.emoji}</span>
          <span className="num">{r.count}</span>
        </button>
      ))}
      {open ? (
        <div className="rx-picker" role="group" aria-label="Choose a reaction">
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              className={mineSet.has(emoji) ? 'mine' : ''}
              aria-label={`React ${emoji}`}
              onClick={() => press(emoji, mineSet.has(emoji))}
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : (
        <button
          className="rx-add"
          disabled={busy}
          aria-label="Add a reaction"
          onClick={() => setOpen(true)}
        >
          +
        </button>
      )}
      <Link to={`/feed/${event.id}`} className="rx-count" aria-label={`Comments, ${comments}`}>
        {comments ? `${comments} ${comments === 1 ? 'comment' : 'comments'}` : 'Comment'}
      </Link>
    </div>
  );
}
