/**
 * The badges page: your level and XP, every badge as a tile (earned first, then closest to done,
 * then locked, secrets as "?"), a Limited time row for badges with a deadline, and the detail sheet
 * on tap. Also opens for someone else (/u/:id/badges) where only what they've earned shows.
 */
import {
  BADGE_FAMILY_LABELS,
  compactNumber,
  todayIn,
  type BadgeFamily,
  type BadgeView,
} from '@gauntlet/shared';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { BadgeIcon, medalOf } from '../components/BadgeIcon';
import { BadgeSheet } from '../components/BadgeSheet';
import { Empty, ErrorBox, Header, Screen } from '../components/ui';
import { SkeletonCard, SkeletonGroup, SkeletonLine } from '../components/Skeleton';
import { useAuth } from '../lib/auth';
import { useBadgeCatalog } from '../lib/badgeQueries';
import { endsText, groupCatalog, levelFraction, progressPct, tierLabelOf } from '../lib/badges';
import { fmtInt } from '../lib/format';
import '../styles/badges.css';

function Tile({
  b,
  today,
  onOpen,
  showProgress,
}: {
  b: BadgeView;
  today: string;
  onOpen: () => void;
  showProgress: boolean;
}) {
  const pct = Math.round(progressPct(b) * 100);
  const earned = b.tier > 0;
  const tier = tierLabelOf(b);
  const label = b.hidden
    ? 'Secret badge'
    : `${b.name}${tier ? `, ${tier}` : earned ? ', earned' : ', locked'}${showProgress && b.progress ? `, ${pct}% there` : ''}`;
  return (
    <button
      className={`bd-tile${b.window && !earned ? ' bd-limited' : ''}${earned ? '' : ' dim'}`}
      onClick={onOpen}
      aria-label={label}
      data-testid="badge-tile"
      data-key={b.key}
    >
      {b.unseen && <span className="bd-new">New</span>}
      <BadgeIcon
        icon={b.icon}
        imageUrl={b.imageUrl}
        medal={medalOf(b)}
        hidden={b.hidden}
        size="lg"
      />
      <span className="bd-name">{b.hidden ? '?' : b.name}</span>
      {b.tiers.length > 1 ? (
        <span className="bd-pips" aria-hidden>
          {b.tiers.map((t) => (
            <i key={t.tier} className={t.tier <= b.tier ? 'on' : ''} />
          ))}
        </span>
      ) : (
        <span className="bd-pips" />
      )}
      {showProgress && b.progress && !b.hidden ? (
        <>
          <div className="track" aria-hidden>
            <i style={{ width: `${pct}%` }} />
          </div>
          <small className="num">
            {compactNumber(b.progress.value)} / {compactNumber(b.progress.target)}
          </small>
        </>
      ) : b.window && !earned ? (
        <small className="bd-ends">{endsText(b.window, today)}</small>
      ) : (
        <small>{b.hidden ? 'Keep moving' : earned ? (tier ?? 'Earned') : ''}</small>
      )}
    </button>
  );
}

function Section({
  title,
  badges,
  ...rest
}: {
  title: string;
  badges: BadgeView[];
  today: string;
  onOpen: (b: BadgeView) => void;
  showProgress: boolean;
}) {
  if (!badges.length) return null;
  return (
    <section>
      <div className="lbl">
        <span>{title}</span>
        <span className="muted num" style={{ textTransform: 'none', letterSpacing: 0 }}>
          {badges.length}
        </span>
      </div>
      <div className="bd-grid">
        {badges.map((b) => (
          <Tile
            key={b.key}
            b={b}
            today={rest.today}
            showProgress={rest.showProgress}
            onOpen={() => rest.onOpen(b)}
          />
        ))}
      </div>
    </section>
  );
}

export function BadgesPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const userId = id ?? user?.id ?? '';
  const own = !id || id === user?.id;
  const q = useBadgeCatalog(userId);
  const [family, setFamily] = useState<BadgeFamily | 'all'>('all');
  const [open, setOpen] = useState<BadgeView | null>(null);
  const today = user ? todayIn(user.timezone) : '';
  const data = q.data;

  const shown = useMemo(
    () => (data?.badges ?? []).filter((b) => family === 'all' || b.family === family),
    [data, family],
  );
  const groups = useMemo(() => groupCatalog(shown, today), [shown, today]);
  const families = useMemo(() => {
    const present = new Set((data?.badges ?? []).filter((b) => !b.hidden).map((b) => b.family));
    return (Object.keys(BADGE_FAMILY_LABELS) as BadgeFamily[]).filter((f) => present.has(f));
  }, [data]);
  const first = data?.user.displayName.split(' ')[0] ?? 'Their';

  return (
    <Screen>
      <Header title={own ? 'Badges' : `${first}'s badges`} back />
      <ErrorBox error={q.error} />
      {q.isPending && (
        <SkeletonGroup>
          <SkeletonCard lines={2} />
          <div className="bd-grid">
            {Array.from({ length: 6 }, (_, i) => (
              <SkeletonCard key={i}>
                <SkeletonLine
                  width={56}
                  height={56}
                  style={{ margin: '0 auto', borderRadius: 14 }}
                />
                <SkeletonLine width="70%" style={{ margin: '0 auto' }} />
              </SkeletonCard>
            ))}
          </div>
        </SkeletonGroup>
      )}
      {q.isSuccess && !data && (
        <div className="list">
          <Empty title="Badges not available">This person keeps their stats to themselves.</Empty>
        </div>
      )}
      {data && (
        <div className="stack" style={{ gap: 4 }}>
          <div className="card bd-level" data-testid="level-card">
            <div className="bd-level-top">
              <b>Level {data.level.level}</b>
              <span className="num">
                {fmtInt(data.level.xp)} / {fmtInt(data.level.nextLevelXp)} XP
              </span>
            </div>
            <div
              className="bd-xp"
              role="progressbar"
              aria-label="Progress to the next level"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(levelFraction(data.level) * 100)}
            >
              <i style={{ width: `${levelFraction(data.level) * 100}%` }} />
            </div>
            <small className="muted">
              {data.earnedCount} badge{data.earnedCount === 1 ? '' : 's'} earned
              {own
                ? ` · ${fmtInt(data.level.nextLevelXp - data.level.xp)} XP to level ${data.level.level + 1}`
                : ''}
            </small>
          </div>

          {families.length > 1 && (
            <div className="bd-chips" role="group" aria-label="Filter by type">
              <button
                className="bd-chip"
                aria-pressed={family === 'all'}
                onClick={() => setFamily('all')}
              >
                All
              </button>
              {families.map((f) => (
                <button
                  key={f}
                  className="bd-chip"
                  aria-pressed={family === f}
                  onClick={() => setFamily(f)}
                >
                  {BADGE_FAMILY_LABELS[f]}
                </button>
              ))}
            </div>
          )}

          {own && (
            <Section
              title="Limited time"
              badges={groups.limited}
              today={today}
              showProgress
              onOpen={setOpen}
            />
          )}
          <Section
            title="Earned"
            badges={groups.earned}
            today={today}
            showProgress={own}
            onOpen={setOpen}
          />
          {own && (
            <Section
              title="In progress"
              badges={groups.inProgress}
              today={today}
              showProgress
              onOpen={setOpen}
            />
          )}
          {own && (
            <Section
              title="Locked"
              badges={groups.locked}
              today={today}
              showProgress
              onOpen={setOpen}
            />
          )}
          {own && (
            <Section
              title="Secret"
              badges={groups.secret}
              today={today}
              showProgress={false}
              onOpen={setOpen}
            />
          )}
          {data.earnedCount === 0 && !own && (
            <div className="list">
              <Empty title="Nothing earned yet">{first} hasn't earned a badge yet.</Empty>
            </div>
          )}
        </div>
      )}
      {open && data && (
        <BadgeSheet
          badgeKey={open.key}
          userId={userId}
          initial={open}
          showcase={data.showcase}
          who={first}
          level={data.level.level}
          onClose={() => setOpen(null)}
        />
      )}
    </Screen>
  );
}
