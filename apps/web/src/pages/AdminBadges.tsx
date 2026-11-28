/**
 * Admin → Badges: Live, Drafts and Retired lists (tap one to edit), and Suggested, where ideas from
 * the Garmin badge database wait to be approved into drafts. Server admins only (see App.tsx).
 */
import {
  ruleTiers,
  BADGE_FAMILY_LABELS,
  describeRule,
  type AdminBadge,
  type BadgeBackfillStatus,
  type BadgeSuggestion,
  type SuggestionStatus,
} from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { BadgeEditor, type EditorMode } from '../components/BadgeEditor';
import { BadgeIcon } from '../components/BadgeIcon';
import { Empty, ErrorBox, Header, Screen, Skeleton, toast } from '../components/ui';
import {
  adminBadgeKeys,
  useAdminBadgeList,
  useImportStatus,
  useSuggestions,
} from '../lib/adminBadges';
import { useBackHandler } from '../lib/useBackHandler';
import { when } from '../lib/admin';
import { adminUserKeys, useBadgeBackfill } from '../lib/adminUsers';
import { ApiError, post } from '../lib/api';
import { fmtInt } from '../lib/format';
import '../styles/admin.css';
import '../styles/badges-admin.css';

type Tab = 'live' | 'draft' | 'retired' | 'suggested';
const TABS: { value: Tab; label: string }[] = [
  { value: 'live', label: 'Live' },
  { value: 'draft', label: 'Drafts' },
  { value: 'retired', label: 'Retired' },
  { value: 'suggested', label: 'Suggested' },
];
const ORIGIN: Record<AdminBadge['origin'], string> = {
  builtin: 'Built-in',
  garmin: 'Garmin idea',
  admin: 'Custom',
};

export function AdminBadgesPage() {
  const [tab, setTab] = useState<Tab>('live');
  const [editor, setEditor] = useState<EditorMode | null>(null);
  const list = useAdminBadgeList();
  const status = useImportStatus();
  const backfill = useBadgeBackfill();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [publishing, setPublishing] = useState<string[] | null | 'all'>(null);
  const counts = {
    live: list.data?.filter((b) => b.status === 'live').length,
    draft: list.data?.filter((b) => b.status === 'draft').length,
    retired: list.data?.filter((b) => b.status === 'retired').length,
    suggested: status.data?.counts.matched,
  };

  if (editor)
    return (
      <Screen tabs={false}>
        <BadgeEditor
          // A saved badge turns the form into that badge's editor, so Preview and Publish are next.
          key={
            editor.kind === 'edit'
              ? editor.badge.key + editor.badge.version + editor.badge.status
              : editor.kind
          }
          mode={editor}
          onClose={() => setEditor(null)}
          onSaved={(badge) => setEditor({ kind: 'edit', badge })}
        />
      </Screen>
    );

  return (
    <Screen tabs={false}>
      <Header
        title="Badges"
        back="/admin"
        action={
          <button className="btn sm" onClick={() => setEditor({ kind: 'new' })}>
            New badge
          </button>
        }
      />
      <div className="seg bda-tabs" role="tablist" aria-label="Badge lists">
        {TABS.map((t) => (
          <button
            key={t.value}
            role="tab"
            aria-selected={tab === t.value}
            aria-pressed={tab === t.value}
            onClick={() => setTab(t.value)}
          >
            {t.label}
            {counts[t.value] ? <span className="bda-count">{counts[t.value]}</span> : null}
          </button>
        ))}
      </div>

      {backfill.data?.running && <AwardProgress s={backfill.data} />}

      {tab === 'draft' && (list.data?.filter((b) => b.status === 'draft').length ?? 0) > 0 && (
        <div className="bda-bulk">
          <button className="btn sm" onClick={() => setPublishing('all')}>
            Publish all ({counts.draft})
          </button>
          {selected.size > 0 && (
            <button className="btn sm secondary" onClick={() => setPublishing([...selected])}>
              Publish selected ({selected.size})
            </button>
          )}
        </div>
      )}

      {tab === 'suggested' ? (
        <Suggested
          onOpen={(s) => setEditor({ kind: 'suggestion', suggestion: s })}
          onOpenBadge={(b) => setEditor({ kind: 'edit', badge: b })}
          badges={list.data ?? []}
        />
      ) : (
        <>
          <ErrorBox error={list.error} />
          {list.isPending ? (
            <Skeleton height={200} style={{ marginTop: 14 }} />
          ) : (
            <BadgeRows
              rows={(list.data ?? []).filter((b) => b.status === tab)}
              tab={tab}
              onOpen={(b) => setEditor({ kind: 'edit', badge: b })}
              selected={tab === 'draft' ? selected : undefined}
              onToggle={(key) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (!next.delete(key)) next.add(key);
                  return next;
                })
              }
            />
          )}
        </>
      )}
      {publishing && (
        <PublishAllSheet
          count={publishing === 'all' ? (counts.draft ?? 0) : publishing.length}
          keys={publishing === 'all' ? undefined : publishing}
          onClose={() => setPublishing(null)}
          onDone={async () => {
            setPublishing(null);
            setSelected(new Set());
            await qc.invalidateQueries({ queryKey: ['admin'] });
            await qc.invalidateQueries({ queryKey: adminUserKeys.backfill });
          }}
        />
      )}
    </Screen>
  );
}

function BadgeRows({
  rows,
  tab,
  onOpen,
  selected,
  onToggle,
}: {
  rows: AdminBadge[];
  tab: Tab;
  onOpen: (b: AdminBadge) => void;
  /** Drafts only: which are ticked for "Publish selected". */
  selected?: Set<string>;
  onToggle?: (key: string) => void;
}) {
  if (!rows.length)
    return (
      <div className="list" style={{ marginTop: 14 }}>
        <Empty
          title={
            tab === 'draft' ? 'No drafts' : tab === 'retired' ? 'Nothing retired' : 'No live badges'
          }
        >
          {tab === 'draft'
            ? 'Make a new badge, or approve an idea under Suggested.'
            : tab === 'retired'
              ? 'Retired badges show up here. People who earned them keep them.'
              : 'Publish a draft to make it live.'}
        </Empty>
      </div>
    );
  return (
    <div className="list" style={{ marginTop: 14 }} data-testid="admin-badge-list">
      {rows.map((b) => (
        <div key={b.key} className="bda-selrow">
          {selected && (
            <label className="bda-pick">
              <input
                type="checkbox"
                checked={selected.has(b.key)}
                onChange={() => onToggle?.(b.key)}
                aria-label={`Select ${b.name}`}
              />
            </label>
          )}
          <button className="item bda-row" onClick={() => onOpen(b)} aria-label={`Edit ${b.name}`}>
            <BadgeIcon
              icon={b.icon}
              imageUrl={b.imageUrl}
              medal={'tiers' in b.rule && b.rule.tiers.length > 1 ? 'gold' : 'single'}
              size={44}
            />
            <div className="grow">
              <div className="t ellipsis">{b.name}</div>
              <small className="bda-rule">{describeRule(b.rule, b.window)}</small>
              <div className="bda-tags">
                <span className="pill plain">{BADGE_FAMILY_LABELS[b.family]}</span>
                <span className="pill plain">{ORIGIN[b.origin]}</span>
                {b.secret && <span className="pill plain">Secret</span>}
                {b.window && <span className="pill">Limited time</span>}
              </div>
            </div>
            <div className="bda-earned">
              <b className="num">{fmtInt(b.earnedBy)}</b>
              <small>earned</small>
            </div>
          </button>
        </div>
      ))}
    </div>
  );
}

const FILTERS: { value: SuggestionStatus; label: string }[] = [
  { value: 'matched', label: 'Matched' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'failed', label: 'Failed' },
  { value: 'approved', label: 'Approved' },
  { value: 'dismissed', label: 'Dismissed' },
];

function Suggested({
  onOpen,
  onOpenBadge,
  badges,
}: {
  onOpen: (s: BadgeSuggestion) => void;
  onOpenBadge: (b: AdminBadge) => void;
  badges: AdminBadge[];
}) {
  const qc = useQueryClient();
  const status = useImportStatus();
  const [filter, setFilter] = useState<SuggestionStatus>('matched');
  const items = useSuggestions(filter);
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const s = status.data;
  const running = !!s?.running || starting;

  // When a check finishes, load what it found.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && s && !s.running) {
      void qc.invalidateQueries({ queryKey: adminBadgeKeys.suggestionsAll });
      setStarting(false);
    }
    wasRunning.current = !!s?.running;
  }, [s, qc]);

  async function run(retry: boolean) {
    setError(null);
    setStarting(true);
    try {
      await post('/api/admin/badge-suggestions/run', retry ? { retry: true } : {});
      await qc.invalidateQueries({ queryKey: adminBadgeKeys.status });
    } catch (err) {
      setStarting(false);
      setError(err);
    }
  }

  return (
    <div className="stack" style={{ gap: 12, marginTop: 14 }}>
      <div className="card stack" style={{ gap: 10 }} data-testid="import-status">
        <b>Ideas from the Garmin badge database</b>
        {!s ? (
          <Skeleton height={60} />
        ) : !s.enabled ? (
          <small className="muted" style={{ lineHeight: 1.5 }}>
            Suggestions are off. Add ANTHROPIC_API_KEY to deploy/.env to turn this on.
          </small>
        ) : (
          <>
            <small className="muted">
              Model: {s.model}.{' '}
              {running
                ? 'Checking for new badges…'
                : s.lastRunAt
                  ? `Last checked ${when(s.lastRunAt)}.`
                  : 'Never checked yet.'}
            </small>
            {s.lastResult && !running && (
              <small className="muted">
                Found {s.lastResult.fetched}, new {s.lastResult.added}: {s.lastResult.matched}{' '}
                matched, {s.lastResult.skipped} skipped, {s.lastResult.failed} failed.
              </small>
            )}
            {s.lastResult?.error && !running && <div className="error">{s.lastResult.error}</div>}
            {running && (
              <div className="adm-progress">
                <span className="adm-spin" /> Working… this can take a few minutes.
              </div>
            )}
          </>
        )}
        <ErrorBox error={error} />
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button
            className="btn sm"
            disabled={!s?.enabled || running}
            onClick={() => void run(false)}
          >
            Check now
          </button>
          <button
            className="btn secondary sm"
            disabled={!s?.enabled || running}
            onClick={() => void run(true)}
          >
            Retry skipped &amp; failed
          </button>
        </div>
      </div>

      <div
        className="bd-chips"
        role="group"
        aria-label="Filter suggestions"
        style={{ marginTop: 0 }}
      >
        {FILTERS.map((f) => (
          <button
            key={f.value}
            className="bd-chip"
            aria-pressed={filter === f.value}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
            {s ? ` ${s.counts[f.value]}` : ''}
          </button>
        ))}
      </div>

      <ErrorBox error={items.error} />
      {items.isPending ? (
        <Skeleton height={160} />
      ) : items.data?.length ? (
        items.data.map((x) => (
          <SuggestionCard
            key={x.id}
            s={x}
            enabled={!!s?.enabled}
            onOpen={() => onOpen(x)}
            onOpenBadge={() => {
              const b = badges.find((y) => y.key === x.badgeKey);
              if (b) onOpenBadge(b);
            }}
          />
        ))
      ) : (
        <div className="list">
          <Empty title={`No ${filter} ideas`}>
            {filter === 'matched' ? 'New ideas show up here after a check.' : 'Nothing here.'}
          </Empty>
        </div>
      )}

      <small className="muted bda-credit">
        Ideas from the community Garmin Badge Database (garminbadges.com) by Next Source. Badge
        names and art belong to Garmin; Gauntlet badges are our own.
      </small>
    </div>
  );
}

function SuggestionCard({
  s,
  enabled,
  onOpen,
  onOpenBadge,
}: {
  s: BadgeSuggestion;
  enabled: boolean;
  onOpen: () => void;
  onOpenBadge: () => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const d = s.draft;

  async function go(path: string, body: unknown, done: string) {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/admin/badge-suggestions/${s.id}/${path}`, body);
      await Promise.all([
        qc.invalidateQueries({ queryKey: adminBadgeKeys.suggestionsAll }),
        qc.invalidateQueries({ queryKey: adminBadgeKeys.status }),
        qc.invalidateQueries({ queryKey: adminBadgeKeys.list }),
      ]);
      toast(done);
    } catch (err) {
      setError(err);
      if (err instanceof ApiError && err.code === 'badge_exists')
        toast('That key is taken. Use Approve to pick another.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack bda-sugg" style={{ gap: 10 }} data-testid="suggestion">
      <div className="bda-garmin">
        <small className="bda-kick">Garmin idea</small>
        <b>{s.source.name}</b>
        <small className="muted">{s.source.description}</small>
        <a href={s.source.url} target="_blank" rel="noopener noreferrer" className="bda-link">
          View on garminbadges.com
        </a>
      </div>
      {d && (
        <div className="bda-draft">
          <BadgeIcon
            icon={d.icon}
            imageUrl={d.imageUrl}
            medal={'tiers' in d.rule && d.rule.tiers.length > 1 ? 'gold' : 'single'}
            size={44}
          />
          <div className="grow">
            <small className="bda-kick">Gauntlet version</small>
            <b>{d.name}</b>
            <small className="muted">{exampleDescription(d)}</small>
            <small className="bda-rule">{describeRule(d.rule, d.window)}</small>
          </div>
        </div>
      )}
      {(s.status === 'skipped' || s.status === 'failed') && s.reason && (
        <small className={s.status === 'failed' ? 'bde-err' : 'muted'}>
          {s.status === 'failed' ? 'Failed: ' : 'Skipped: '}
          {s.reason}
        </small>
      )}
      <ErrorBox error={error} />
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {s.status === 'matched' && d && (
          <>
            <button className="btn sm" onClick={onOpen} disabled={busy}>
              Approve
            </button>
            <button
              className="btn secondary sm"
              onClick={() => void go('approve', { draft: d }, 'Added as a draft')}
              disabled={busy}
            >
              Quick approve
            </button>
          </>
        )}
        {(s.status === 'skipped' || s.status === 'failed' || s.status === 'dismissed') && (
          <button
            className="btn secondary sm"
            onClick={() => void go('retry', {}, 'Checked again')}
            disabled={busy || !enabled}
          >
            Retry
          </button>
        )}
        {s.status !== 'approved' && s.status !== 'dismissed' && (
          <button
            className="btn ghost sm"
            onClick={() => void go('dismiss', {}, 'Dismissed')}
            disabled={busy}
          >
            Dismiss
          </button>
        )}
        {s.status === 'approved' && s.badgeKey && (
          <button className="btn secondary sm" onClick={onOpenBadge}>
            Open draft
          </button>
        )}
      </div>
    </div>
  );
}

/** "Log {n} workouts" → "Log 20 workouts": the first tier stands in for {n} in admin previews. */
function exampleDescription(d: { description: string; rule: Parameters<typeof ruleTiers>[0] }) {
  const first = ruleTiers(d.rule)[0];
  return first == null ? d.description : d.description.replace(/\{n\}/g, fmtInt(first));
}

function AwardProgress({ s }: { s: BadgeBackfillStatus }) {
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  return (
    <div className="card bda-award" role="status" data-testid="award-progress">
      <div className="adm-progress">
        <span className="adm-spin" aria-hidden="true" />
        Awarding… {s.done} of {s.total}
      </div>
      <div className="adm-bar" role="progressbar" aria-valuenow={pct}>
        <i style={{ width: `${pct}%` }} />
      </div>
      {s.current && <small className="muted">Now: {s.current}</small>}
    </div>
  );
}

function PublishAllSheet({
  count,
  keys,
  onClose,
  onDone,
}: {
  count: number;
  keys?: string[];
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const back = useBackHandler(() => !busy && onClose());
  async function go() {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ published: number }>(
        '/api/admin/badges/publish-all',
        keys ? { keys } : {},
      );
      toast(`${r.published} ${r.published === 1 ? 'badge' : 'badges'} published`);
      await onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  const n = `${count} ${count === 1 ? 'badge' : 'badges'}`;
  return (
    <div
      ref={back.overlayRef}
      className="adm-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Publish badges"
    >
      <div ref={back.targetRef} className="card stack adm-dialog" style={{ gap: 10 }}>
        <h2 style={{ margin: 0 }}>Publish {n}?</h2>
        <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>
          Publishes {n} and quietly awards {count === 1 ? 'it' : 'them'} to everyone who already
          qualifies. This can&apos;t be undone, but you can retire any of them later.
        </p>
        <ErrorBox error={error} />
        <div className="row" style={{ gap: 8 }}>
          <button className="btn secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" onClick={go} disabled={busy || count === 0}>
            Publish {count}
          </button>
        </div>
      </div>
    </div>
  );
}
