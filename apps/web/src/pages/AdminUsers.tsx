/**
 * Admin → Accounts: search and filter everyone on this server, see who is active, who has gone
 * quiet and who is "expired", and clean up expired accounts (always by scheduling a deletion first,
 * never straight away). Server admins only (see App.tsx).
 */
import {
  ACCOUNT_FILTER_LABELS,
  ACCOUNT_FILTERS,
  ACCOUNT_TAG_LABELS,
  EXPIRED_RULE_TEXT,
  type AccountFilter,
  type AccountTag,
  type AdminAuditEntry,
  type AdminUserRow,
  type CleanupResult,
} from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { LevelChip } from '../components/LevelChip';
import { Avatar, Empty, ErrorBox, Header, Screen, Skeleton, toast } from '../components/ui';
import { when } from '../lib/admin';
import { adminUserKeys, lastActiveText, useAdminAudit, useAdminUsers } from '../lib/adminUsers';
import { post } from '../lib/api';
import '../styles/admin.css';
import '../styles/adminUsers.css';

const PAGE = 50;
/** Tags worth showing in a list row (everything but plain "Active"/"Inactive", which the text says). */
const SHOWN: AccountTag[] = ['scheduled', 'expired', 'sync_problem', 'key_lost', 'admin', 'demo'];
const WARN: AccountTag[] = ['scheduled', 'expired', 'sync_problem', 'key_lost'];

export function TagPills({ tags }: { tags: AccountTag[] }) {
  const shown = tags.filter((t) => SHOWN.includes(t));
  if (!shown.length) return null;
  return (
    <div className="au-tags">
      {shown.map((t) => (
        <span key={t} className={`pill ${WARN.includes(t) ? 'warn' : 'plain'}`}>
          {ACCOUNT_TAG_LABELS[t]}
        </span>
      ))}
    </div>
  );
}

export function AdminUsersPage() {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<AccountFilter>('all');
  const [limit, setLimit] = useState(PAGE);
  const [cleanup, setCleanup] = useState(false);
  const list = useAdminUsers(q, filter, limit);
  const audit = useAdminAudit();
  const data = list.data;

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(text.trim());
      setLimit(PAGE);
    }, 250);
    return () => clearTimeout(t);
  }, [text]);

  return (
    <Screen tabs={false}>
      <Header
        title="Accounts"
        back="/admin"
        action={
          <button className="btn sm secondary" onClick={() => setCleanup(true)}>
            Clean up expired
          </button>
        }
      />
      <label className="input au-search">
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search name, @handle or email"
          aria-label="Search accounts"
          autoComplete="off"
        />
      </label>
      <div className="au-chips" role="group" aria-label="Filter accounts">
        {ACCOUNT_FILTERS.map((f) => (
          <button
            key={f}
            className="au-chip"
            aria-pressed={filter === f}
            onClick={() => {
              setFilter(f);
              setLimit(PAGE);
            }}
          >
            {ACCOUNT_FILTER_LABELS[f]}
            {data ? <b>{data.counts[f]}</b> : null}
          </button>
        ))}
      </div>
      {filter === 'expired' && (
        <p className="au-help" style={{ margin: '4px 0 10px' }}>
          {EXPIRED_RULE_TEXT} &quot;Clean up expired&quot; schedules these for deletion in 30 days;
          using the app saves an account.
        </p>
      )}

      <ErrorBox error={list.error} />
      {!data ? (
        <Skeleton height={220} />
      ) : data.users.length === 0 ? (
        <div className="list">
          <Empty title="No accounts match">Try a different search or filter.</Empty>
        </div>
      ) : (
        <div className="list" data-testid="admin-user-list">
          {data.users.map((u) => (
            <UserRow key={u.id} u={u} />
          ))}
        </div>
      )}
      {data && data.total > data.users.length && (
        <button
          className="btn secondary"
          style={{ marginTop: 12 }}
          onClick={() => setLimit(limit + PAGE)}
        >
          Show more ({data.total - data.users.length} left)
        </button>
      )}

      <div className="lbl">Recent admin actions</div>
      <AuditList entries={audit.data} />
      {cleanup && <CleanupSheet onClose={() => setCleanup(false)} />}
    </Screen>
  );
}

function UserRow({ u }: { u: AdminUserRow }) {
  return (
    <Link to={`/admin/users/${u.id}`} className="item au-row" aria-label={`Open ${u.displayName}`}>
      <Avatar user={u} size={42} />
      <div className="grow">
        <div className="au-name">
          <span>{u.displayName}</span>
          <LevelChip level={u.level} />
        </div>
        <small>
          {u.isDemo ? 'Sample data' : `Last active ${lastActiveText(u.lastActiveAt, u.createdAt)}`}
        </small>
        <TagPills tags={u.tags} />
      </div>
    </Link>
  );
}

export function AuditList({ entries }: { entries: AdminAuditEntry[] | undefined }) {
  if (!entries) return <Skeleton height={60} />;
  if (!entries.length) return <small className="muted">Nothing yet.</small>;
  const verb: Record<AdminAuditEntry['action'], string> = {
    schedule_deletion: 'scheduled deletion of',
    cancel_deletion: 'cancelled the deletion of',
    delete_account: 'deleted',
    cleanup_expired: 'cleaned up expired accounts',
    auto_delete: 'deleted (scheduled, unused)',
    auto_keep: 'kept (they came back)',
  };
  return (
    <div className="list">
      {entries.slice(0, 15).map((e, i) => (
        <div key={`${e.at}-${i}`} className="item au-audit">
          <div className="grow">
            <b>{e.adminName}</b> {verb[e.action]}
            {e.targetName ? <b> {e.targetName}</b> : null}
            <small>
              {when(e.at)}
              {e.detail ? ` · ${e.detail}` : ''}
            </small>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Lists who is expired (nothing changes yet), then schedules their deletion on confirm. */
function CleanupSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [preview, setPreview] = useState<CleanupResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    post<CleanupResult>('/api/admin/users/cleanup-expired', { dryRun: true })
      .then(setPreview)
      .catch(setError);
  }, []);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const r = await post<CleanupResult>('/api/admin/users/cleanup-expired', {});
      toast(`${r.accounts.length} ${r.accounts.length === 1 ? 'account' : 'accounts'} scheduled`);
      await qc.invalidateQueries({ queryKey: ['admin'] });
      onClose();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const n = preview?.accounts.length ?? 0;
  return (
    <div className="adm-overlay" role="dialog" aria-modal="true" aria-label="Clean up expired">
      <div className="card stack adm-dialog" style={{ gap: 10 }}>
        <h2 style={{ margin: 0 }}>Clean up expired accounts</h2>
        <p className="au-help" style={{ margin: 0 }}>
          {EXPIRED_RULE_TEXT}
        </p>
        <ErrorBox error={error} />
        {!preview && !error && <Skeleton height={80} />}
        {preview && n === 0 && <div className="adm-ok">No expired accounts right now.</div>}
        {preview && n > 0 && (
          <>
            <p style={{ margin: 0, lineHeight: 1.5 }}>
              <b>{n}</b> {n === 1 ? 'account' : 'accounts'} would be scheduled for deletion in 30
              days. They are told in the app, and using the app saves them. Nothing is deleted
              today.
            </p>
            <ul className="au-who">
              {preview.accounts.map((a) => (
                <li key={a.id}>
                  {a.displayName}
                  <br />
                  <small>{a.reason}</small>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn secondary" onClick={onClose}>
            {n > 0 ? 'Cancel' : 'Close'}
          </button>
          {n > 0 && (
            <button className="btn danger" onClick={confirm} disabled={busy}>
              Schedule {n} for deletion
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
