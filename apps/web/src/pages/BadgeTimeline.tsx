/**
 * A person's badge timeline: every tier they earned, newest first, grouped by month, with how and
 * when and the XP it gave. Tap a row for the badge. Entries from a launch/publish backfill or a
 * history import are tagged, since they weren't earned live. Works for you (/badges/timeline) and
 * for a friend who shares their stats (/u/:id/badges/timeline).
 */
import { tierName, type BadgeTimelineEntry } from '@gauntlet/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { BadgeIcon } from '../components/BadgeIcon';
import { BadgeSheet } from '../components/BadgeSheet';
import { Empty, ErrorBox, Header, Screen } from '../components/ui';
import { SkeletonCard, SkeletonGroup } from '../components/Skeleton';
import { useAuth } from '../lib/auth';
import { useBadgeCatalog, useBadgeTimeline } from '../lib/badgeQueries';
import { cap } from '../lib/badges';
import { fmtDate } from '../lib/format';
import '../styles/badgeTimeline.css';

/** Groups newest-first entries by calendar month, keeping order. */
export function groupByMonth(entries: BadgeTimelineEntry[]) {
  const out: { month: string; entries: BadgeTimelineEntry[] }[] = [];
  for (const e of entries) {
    const month = e.date.slice(0, 7);
    const last = out.at(-1);
    if (last && last.month === month) last.entries.push(e);
    else out.push({ month, entries: [e] });
  }
  return out;
}

function Row({ e, own, onOpen }: { e: BadgeTimelineEntry; own: boolean; onOpen: () => void }) {
  const tn = tierName(e.tier, e.tierCount);
  return (
    <li>
      <button className="tl-row" onClick={onOpen} data-testid="timeline-row" data-key={e.key}>
        <BadgeIcon icon={e.icon} imageUrl={e.imageUrl} medal={tn ?? 'single'} size="sm" />
        <span className="tl-main">
          <b>
            {e.name}
            {tn ? <span className="tl-tier"> · {cap(tn)}</span> : null}
          </b>
          {e.how && <small>{e.how}</small>}
          <small className="tl-meta">
            {fmtDate(e.date, { month: 'short', day: 'numeric', year: 'numeric' })}
            {e.backfilled && (
              <span className="tl-tag">{own ? 'From your history' : 'From their history'}</span>
            )}
          </small>
        </span>
        <b className="num tl-xp">+{e.xp} XP</b>
      </button>
    </li>
  );
}

export function BadgeTimelinePage() {
  const { id } = useParams();
  const { user } = useAuth();
  const userId = id ?? user?.id ?? '';
  const own = !id || id === user?.id;
  const q = useBadgeTimeline(userId);
  const catalog = useBadgeCatalog(userId);
  const [open, setOpen] = useState<string | null>(null);
  const more = useRef<HTMLDivElement>(null);

  const pages = q.data?.pages ?? [];
  const entries = useMemo(() => pages.flatMap((p) => p?.entries ?? []), [pages]);
  const groups = useMemo(() => groupByMonth(entries), [entries]);
  const unavailable = q.isSuccess && pages[0] == null;
  const first = pages[0]?.user.displayName.split(' ')[0] ?? 'Their';

  // Load the next page when the end of the list scrolls into view (the button is the fallback).
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;
  useEffect(() => {
    const el = more.current;
    if (!el || !hasNextPage || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((hits) => {
      if (hits.some((h) => h.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <Screen>
      <Header title={own ? 'Timeline' : `${first}'s timeline`} back />
      <ErrorBox error={q.error} />
      {q.isPending && (
        <SkeletonGroup>
          <SkeletonCard lines={3} />
          <SkeletonCard lines={3} />
        </SkeletonGroup>
      )}
      {unavailable && (
        <div className="list">
          <Empty title="Timeline not available">This person keeps their stats to themselves.</Empty>
        </div>
      )}
      {q.isSuccess && !unavailable && entries.length === 0 && (
        <div className="list">
          <Empty title="Nothing here yet">
            {own
              ? 'Badges you earn will show up here, newest first.'
              : `${first} hasn't earned a badge yet.`}
          </Empty>
        </div>
      )}
      {groups.map((g) => (
        <section key={g.month} data-testid="timeline-month">
          <div className="lbl">
            <span>{fmtDate(`${g.month}-01`, { month: 'long', year: 'numeric' })}</span>
            <span className="muted num" style={{ textTransform: 'none', letterSpacing: 0 }}>
              +{g.entries.reduce((n, e) => n + e.xp, 0)} XP
            </span>
          </div>
          <ol className="card tl-list">
            {g.entries.map((e) => (
              <Row key={`${e.key}-${e.tier}`} e={e} own={own} onOpen={() => setOpen(e.key)} />
            ))}
          </ol>
        </section>
      ))}
      {hasNextPage && (
        <div ref={more} className="tl-more">
          <button
            className="btn secondary"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
      {open && (
        <BadgeSheet
          badgeKey={open}
          userId={userId}
          showcase={catalog.data?.showcase ?? []}
          who={first}
          level={catalog.data?.level.level}
          onClose={() => setOpen(null)}
        />
      )}
    </Screen>
  );
}
