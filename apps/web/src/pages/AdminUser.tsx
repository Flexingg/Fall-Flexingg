/**
 * Admin → one account: what the server knows about them (never keys or tokens), their challenges,
 * and the three ways to remove an account: schedule it (30 days, saved by using the app), cancel a
 * scheduled deletion, or delete right now (typing their name). Server admins only.
 */
import type { AdminUserDetail } from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Icon } from '../components/Icon';
import { LevelChip } from '../components/LevelChip';
import { Avatar, ErrorBox, Header, Screen, Skeleton, toast } from '../components/ui';
import { when } from '../lib/admin';
import { adminUserKeys, lastActiveText, useAdminUser } from '../lib/adminUsers';
import { api, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateRange } from '../lib/format';
import '../styles/admin.css';
import '../styles/adminUsers.css';
import { TagPills } from './AdminUsers';

export function AdminUserPage() {
  const { id = '' } = useParams();
  const q = useAdminUser(id);
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [sheet, setSheet] = useState<'schedule' | 'delete' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const u = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin'] });
  const protectedAccount = !!u && (u.isAdmin || u.isDemo || u.id === me?.id);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/admin/users/${id}/cancel-deletion`);
      toast('Deletion cancelled');
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen tabs={false}>
      <Header title="Account" back="/admin/users" />
      <ErrorBox error={q.error} />
      <ErrorBox error={error} />
      {!u ? (
        <Skeleton height={240} />
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          <div className="card stack" style={{ gap: 10 }}>
            <div className="au-top">
              <Avatar user={u} size={56} />
              <div className="grow" style={{ minWidth: 0 }}>
                <h2>
                  {u.displayName} <LevelChip level={u.level} />
                </h2>
                <small className="muted" style={{ overflowWrap: 'anywhere' }}>
                  {u.handle ? `@${u.handle} · ` : ''}
                  {u.email}
                </small>
              </div>
            </div>
            <TagPills tags={u.tags} />
            {!u.isDemo && (
              <Link
                to={`/u/${u.id}`}
                className="btn secondary sm"
                style={{ alignSelf: 'flex-start' }}
              >
                <Icon name="user" size={16} /> View profile
              </Link>
            )}
          </div>

          {u.deletionScheduledAt && (
            <div className="au-warn" role="status">
              <b>Scheduled for deletion on {when(u.deletionScheduledAt)}.</b>
              {u.deletionReason ? ` Reason: ${u.deletionReason}.` : ''}{' '}
              {u.activeSinceScheduled
                ? 'They have used the app since, so it will be called off.'
                : 'If they use the app before then, it is called off.'}
              <div style={{ marginTop: 8 }}>
                <button className="btn sm secondary" disabled={busy} onClick={cancel}>
                  Cancel scheduled deletion
                </button>
              </div>
            </div>
          )}
          {u.expiredReason && !u.deletionScheduledAt && (
            <div className="au-warn" role="status">
              <b>Expired:</b> {u.expiredReason}.
            </div>
          )}

          <Section title="Activity">
            <Info
              rows={[
                ['Last active', lastActiveText(u.lastActiveAt, u.createdAt)],
                ['Joined', when(u.createdAt)],
                ['Last synced', when(u.lastSyncedAt)],
                [
                  'SparkyFitness',
                  u.keyStatus === 'active' ? 'Connected' : 'Connection lost (needs to sign in)',
                ],
                ...(u.lastSyncError
                  ? ([['Last sync error', `${u.lastSyncError} (${when(u.lastSyncErrorAt)})`]] as [
                      string,
                      string,
                    ][])
                  : []),
                ['Time zone', u.timezone],
              ]}
            />
          </Section>

          <Section title="Settings and data">
            <Info
              rows={[
                ['Profile', u.visibility === 'public' ? 'Public' : 'Private'],
                [
                  'Shares',
                  [
                    u.sharing.workoutDetails && 'workout details',
                    u.sharing.events && 'events',
                    u.sharing.profileStats && 'profile stats',
                  ]
                    .filter(Boolean)
                    .join(', ') || 'nothing extra',
                ],
                [
                  'Data sources',
                  u.dataSources.sources.length
                    ? `${u.dataSources.sources.join(', ')} (${u.dataSources.metrics} kinds of data)`
                    : 'none seen yet',
                ],
                ['Health Connect', u.healthConnectSync ? 'On' : 'Off'],
                [
                  'Notifications',
                  `${u.recentNotifications} in 30 days · ${u.notificationPrefsSet} changed from default`,
                ],
                [
                  'Notify on',
                  `${u.pushTargets.webpush} browser${u.pushTargets.webpush === 1 ? '' : 's'}, ${u.pushTargets.device} phone${u.pushTargets.device === 1 ? '' : 's'}`,
                ],
                ['Badges', `${u.badges.earned} earned · level ${u.level} (${u.badges.xp} XP)`],
              ]}
            />
          </Section>

          <Section title={`Challenges (${u.challengeList.length})`}>
            {u.challengeList.length === 0 ? (
              <small className="muted">Not in any challenges.</small>
            ) : (
              <div className="list">
                {u.challengeList.map((c) => (
                  <Link key={c.id} to={`/c/${c.id}`} className="item au-row">
                    <div className="grow">
                      <div className="t">{c.name}</div>
                      <small>
                        {dateRange(c.startDate, c.endDate)} ·{' '}
                        {c.status === 'active'
                          ? 'running'
                          : c.status === 'upcoming'
                            ? 'upcoming'
                            : c.rank
                              ? `finished, place ${c.rank}`
                              : 'finished'}
                        {c.state !== 'joined' ? ` · ${c.state}` : ''}
                        {c.createdByThem ? ' · made by them' : ''}
                      </small>
                    </div>
                    <Icon name="chevron" size={16} />
                  </Link>
                ))}
              </div>
            )}
          </Section>

          <Section title={`Friends (${u.friendNames.length})`}>
            <small className="muted">
              {u.friendNames.length ? u.friendNames.join(', ') : 'No friends yet.'}
            </small>
          </Section>

          <Section title="Remove this account">
            {protectedAccount ? (
              <small className="muted">
                {u.isDemo
                  ? 'The demo account cannot be deleted.'
                  : u.id === me?.id
                    ? 'You cannot delete your own account here.'
                    : 'Admin accounts cannot be deleted from here.'}
              </small>
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                {!u.deletionScheduledAt && (
                  <button className="btn secondary" onClick={() => setSheet('schedule')}>
                    Schedule deletion
                  </button>
                )}
                <button className="btn danger" onClick={() => setSheet('delete')}>
                  Delete now
                </button>
              </div>
            )}
          </Section>
        </div>
      )}
      {u && sheet === 'schedule' && (
        <ScheduleSheet
          u={u}
          onClose={() => setSheet(null)}
          onDone={async () => {
            setSheet(null);
            toast('Deletion scheduled');
            await refresh();
          }}
        />
      )}
      {u && sheet === 'delete' && (
        <DeleteSheet
          u={u}
          onClose={() => setSheet(null)}
          onDone={async () => {
            toast('Account deleted');
            await qc.invalidateQueries({ queryKey: adminUserKeys.all });
            navigate('/admin/users', { replace: true });
          }}
        />
      )}
    </Screen>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="lbl" style={{ marginTop: 4 }}>
        {title}
      </div>
      <div className="card">{children}</div>
    </section>
  );
}

function Info({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="au-kv">
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function ScheduleSheet({
  u,
  onClose,
  onDone,
}: {
  u: AdminUserDetail;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/admin/users/${u.id}/schedule-deletion`, {
        reason: reason.trim() || undefined,
      });
      await onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <div className="adm-overlay" role="dialog" aria-modal="true" aria-label="Schedule deletion">
      <div className="card stack adm-dialog" style={{ gap: 10 }}>
        <h2 style={{ margin: 0 }}>Schedule deletion of {u.displayName}?</h2>
        <ul className="adm-steps">
          <li>
            The account is deleted in <b>30 days</b>. Nothing happens today.
          </li>
          <li>
            They get a message in the app saying so, and a banner with a Keep my account button.
          </li>
          <li>
            If they use the app before then, the deletion is called off. You can also cancel it
            here.
          </li>
        </ul>
        <label className="input">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
            placeholder="Reason (only admins see it)"
            aria-label="Reason"
          />
        </label>
        <ErrorBox error={error} />
        <div className="row" style={{ gap: 8 }}>
          <button className="btn secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger" onClick={go} disabled={busy}>
            Schedule deletion
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteSheet({
  u,
  onClose,
  onDone,
}: {
  u: AdminUserDetail;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/users/${u.id}`, { method: 'DELETE', json: { confirm: text.trim() } });
      await onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <div className="adm-overlay" role="dialog" aria-modal="true" aria-label="Delete account now">
      <div className="card stack adm-dialog" style={{ gap: 10 }}>
        <h2 style={{ margin: 0 }}>Delete {u.displayName} now?</h2>
        <ul className="adm-steps">
          <li>
            <b>This cannot be undone.</b> Their account, friends, scores and badges are removed
            straight away.
          </li>
          <li>
            Challenges they made that other people are in stay, handed to another member. Their
            SparkyFitness data is not touched.
          </li>
          <li>
            Prefer a gentler way? Schedule the deletion instead and they get 30 days to come back.
          </li>
        </ul>
        <ErrorBox error={error} />
        <label className="input">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label={`Type ${u.displayName} to confirm`}
            autoComplete="off"
          />
          <span>Type {u.displayName} to confirm</span>
        </label>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn danger"
            onClick={go}
            disabled={busy || text.trim() !== u.displayName}
          >
            Delete now
          </button>
        </div>
      </div>
    </div>
  );
}
