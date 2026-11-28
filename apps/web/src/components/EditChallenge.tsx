import type { ChallengeDetail, UpdateChallengeRequest } from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { patch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateRange } from '../lib/format';
import { StakeField } from './Stake';
import { ErrorBox, toast, Toggle } from './ui';
import { invalidateSyncedData } from '../lib/syncedData';

/** What the creator can change after a challenge exists. Dates stay as they were created. */
export function EditChallenge({ c, onDone }: { c: ChallengeDetail; onDone: () => void }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [name, setName] = useState(c.name);
  const [isPublic, setPublic] = useState(c.visibility === 'public');
  const [showEvents, setShowEvents] = useState(c.showEvents);
  const [stake, setStake] = useState(c.stake ?? '');
  const [repeats, setRepeats] = useState(!!c.recurrence);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const others = c.participantCount - 1;
  // A side bet is set before the start, so nobody joins under one rule and plays under another.
  const canEditStake = !c.soloConfig && c.status === 'upcoming';
  const canGoPublic = user?.visibility === 'public' || c.visibility === 'public';

  async function save() {
    const body: UpdateChallengeRequest = {};
    if (name.trim() && name.trim() !== c.name) body.name = name.trim();
    if (isPublic !== (c.visibility === 'public')) body.visibility = isPublic ? 'public' : 'private';
    if (showEvents !== c.showEvents) body.showEvents = showEvents;
    if (canEditStake && stake.trim().replace(/\s+/g, ' ') !== (c.stake ?? ''))
      body.stake = stake.trim() || null;
    if (c.recurrence && !repeats) body.recurrence = null;
    if (!Object.keys(body).length) return onDone();
    if (
      body.visibility === 'private' &&
      others > 0 &&
      !confirm(
        'Make this challenge private? It leaves Discover. People already in it stay, and new people need an invite.',
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await patch(`/api/challenges/${c.id}`, body);
      await invalidateSyncedData(qc);
      toast('Saved');
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack" style={{ marginBottom: 14, gap: 12 }} aria-label="Edit challenge">
      <b>Edit challenge</b>
      <label className="input">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          aria-label="Challenge name"
        />
        <span>Name</span>
      </label>
      {!c.soloConfig && (
        <div className="row">
          <div className="grow">
            <div style={{ fontWeight: 700 }}>Public</div>
            <small className="muted">
              {isPublic
                ? 'Listed in Discover. Anyone with a public profile can join.'
                : 'Invite only: friends you pick and people with the link.'}
            </small>
          </div>
          <Toggle
            checked={isPublic}
            onChange={setPublic}
            label="Public challenge"
            disabled={!canGoPublic}
          />
        </div>
      )}
      {!c.soloConfig && !canGoPublic && (
        <small className="muted">
          Make your profile public (<Link to="/me">Profile</Link>) to make this challenge public.
        </small>
      )}
      <div className="row">
        <div className="grow">
          <div style={{ fontWeight: 700 }}>Show events</div>
          <small className="muted">
            Participants can open the workouts, sets and fasts behind each score.
          </small>
        </div>
        <Toggle checked={showEvents} onChange={setShowEvents} label="Show events" />
      </div>
      {canEditStake && <StakeField value={stake} onChange={setStake} />}
      {c.recurrence && (
        <div className="row">
          <div className="grow">
            <div style={{ fontWeight: 700 }}>Repeat</div>
            <small className="muted">
              {repeats
                ? `Repeats ${c.recurrence.every === 'week' ? 'weekly' : 'monthly'}: a new round starts when this one ends.`
                : 'This is the last round. No new round will start.'}
            </small>
          </div>
          <Toggle checked={repeats} onChange={setRepeats} label="Repeat this challenge" />
        </div>
      )}
      <small className="muted" style={{ lineHeight: 1.45 }}>
        Dates ({dateRange(c.startDate, c.endDate)}) are fixed once a challenge is created. Use
        Rematch when it ends to run it again with new dates.
      </small>
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn" disabled={busy} onClick={save}>
          {busy ? <span className="spinner" /> : 'Save'}
        </button>
        <button className="btn secondary" disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}
