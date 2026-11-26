import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, post } from '../lib/api';
import { socialKeys, useNudgeStatus } from '../lib/social';
import { fmtDateTime } from '../lib/format';
import '../styles/social.css';
import { toast } from './ui';

/**
 * "Nudge": a friendly ping to a friend or challenge-mate. Shows nothing when you can't nudge this
 * person, and a disabled "Nudged" until the server's limit lets you again.
 */
export function NudgeButton({
  userId,
  challengeId,
  name,
}: {
  userId: string;
  challengeId?: string;
  name?: string;
}) {
  const qc = useQueryClient();
  const status = useNudgeStatus(userId);
  const [busy, setBusy] = useState(false);
  const s = status.data;
  if (!s || (!s.canNudge && !s.retryAt)) return null;

  async function send() {
    setBusy(true);
    try {
      await post('/api/nudges', { userId, challengeId });
      toast(name ? `Nudged ${name}` : 'Nudged');
    } catch (err) {
      toast(err instanceof ApiError || err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      await qc.invalidateQueries({ queryKey: socialKeys.nudge(userId) });
      setBusy(false);
    }
  }

  const label = name ? `Nudge ${name}` : 'Nudge';
  return s.canNudge ? (
    <button
      className="btn sm secondary nudge-btn"
      disabled={busy}
      aria-label={label}
      onClick={send}
    >
      Nudge
    </button>
  ) : (
    <button
      className="btn sm secondary nudge-btn"
      disabled
      aria-label={name ? `Nudged ${name}` : 'Nudged'}
      title={s.retryAt ? `You can nudge again ${fmtDateTime(s.retryAt)}` : undefined}
    >
      Nudged
    </button>
  );
}
