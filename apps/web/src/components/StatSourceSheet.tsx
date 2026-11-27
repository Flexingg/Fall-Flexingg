/**
 * "Where did this come from?" for one stat on one day, opened by long-pressing it on the day screen
 * or a ring on Today. Shows the value, which source counts and why in plain words, every source that
 * reported it, and (when the phone sent it) which Health Connect apps wrote it, with a warning when
 * two or more wrote the same thing. Swipe down or tap the grab bar to close.
 */
import { formatQuantityFlexible, todayIn, addDays } from '@gauntlet/shared';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { useAuth } from '../lib/auth';
import { useDisplay } from '../lib/display';
import { fmtDate, timeAgo } from '../lib/format';
import { useStatSource } from '../lib/statSourceQueries';
import {
  capitalise,
  overlapHint,
  recordsText,
  usesSourceOrder,
  whyThisSource,
} from '../lib/statSourceText';
import { useSheetDrag } from '../lib/useSheetDrag';
import { Icon } from './Icon';
import { SheetHandle } from './SheetHandle';
import '../styles/statSource.css';

export function StatSourceSheet({
  date,
  metric,
  label,
  onClose,
}: {
  date: string;
  metric: string;
  /** The label already on screen, shown while the details load. */
  label: string;
  onClose: () => void;
}) {
  const { user, mode } = useAuth();
  const display = useDisplay();
  const q = useStatSource(date, metric);
  const drag = useSheetDrag(onClose);
  const r = q.data;
  const direct = mode === 'direct';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const today = user ? todayIn(user.timezone) : '';
  const when =
    date === today
      ? 'Today'
      : date === addDays(today, -1)
        ? 'Yesterday'
        : fmtDate(date, { weekday: 'long', month: 'short', day: 'numeric' });
  const fmt = (v: number | null) =>
    formatQuantityFlexible(v, r?.unit ?? '', r?.decimals ?? 0, display);
  const hint = r?.phone ? overlapHint(r.label, r.phone.apps) : null;

  // In the page body, so a Today that is mid pull-to-refresh can't move or clip it.
  return createPortal(
    <div
      ref={drag.overlayRef}
      className="bd-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Where ${label} came from`}
      data-testid="stat-source-sheet"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div ref={drag.sheetRef} className="bd-sheet stack ss-sheet">
        <SheetHandle drag={drag} />
        <header className="ss-head">
          <small>{when}</small>
          <h2>{r?.label ?? label}</h2>
          {r && (
            <div className="ss-value num" data-testid="stat-source-value">
              {r.value == null ? 'Nothing recorded' : fmt(r.value)}
            </div>
          )}
        </header>

        {q.isPending && <small className="muted">Loading…</small>}
        {q.error && <div className="error">Could not load where this came from.</div>}

        {r && (
          <>
            <section className="ss-sec" aria-label="Which source counts">
              <div className="lbl">Counted from</div>
              {r.source && r.value != null && (
                <div className="ss-counted">
                  <span className="ss-chip">{r.source.label}</span>
                </div>
              )}
              <p className="ss-why" data-testid="stat-source-why">
                {whyThisSource(r, { direct })}
              </p>
              {usesSourceOrder(r) && !direct && !user?.demo && (
                <Link to="/sources" className="ss-link" onClick={onClose}>
                  Change which source counts <Icon name="chevron" size={12} />
                </Link>
              )}
            </section>

            {r.candidates.length > 0 && (
              <section className="ss-sec" aria-label="Every source">
                <div className="lbl">
                  <span>
                    {r.candidates.length === 1 ? 'Source' : 'Every source that reported it'}
                  </span>
                </div>
                <ul className="ss-list" data-testid="stat-source-candidates">
                  {r.candidates.map((c) => (
                    <li key={c.sourceKey} className={c.chosen ? 'on' : ''}>
                      <span className="ss-name">
                        <span>{c.label}</span>
                        {c.chosen && (
                          <em>
                            <Icon name="check" size={12} /> Counted
                          </em>
                        )}
                      </span>
                      <b className="num">{fmt(c.value)}</b>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {r.phone && (
              <section
                className="ss-sec"
                aria-label="On your phone"
                data-testid="stat-source-phone"
              >
                <div className="lbl">On your phone</div>
                <p className="ss-note">
                  Apps that wrote this to Health Connect
                  {r.phone.counted != null && (
                    <>
                      . Health Connect counted <b className="num">{fmt(r.phone.counted)}</b>
                    </>
                  )}
                  .
                </p>
                <ul className="ss-list">
                  {r.phone.apps.map((a) => (
                    <li key={a.packageName}>
                      <span className="ss-name">
                        <span>{a.name}</span>
                        {a.name !== a.packageName && <small>{a.packageName}</small>}
                        <small>
                          {recordsText(a.records)}
                          {a.devices.length > 0 && ` · ${a.devices.map(capitalise).join(', ')}`}
                        </small>
                      </span>
                      <b className="num">{fmt(a.value)}</b>
                    </li>
                  ))}
                </ul>
                {hint && (
                  <p className="ss-warn" role="note" data-testid="stat-source-overlap">
                    {hint}
                  </p>
                )}
                {r.phone.capped && (
                  <p className="ss-note">
                    Your phone stopped reading at its limit, so the app numbers here may be a little
                    short.
                  </p>
                )}
              </section>
            )}

            <small className="muted ss-foot">
              {r.updatedAt
                ? `Gauntlet last updated this ${timeAgo(r.updatedAt)}.`
                : r.phone
                  ? `Your phone last reported this ${timeAgo(r.phone.reportedAt)}.`
                  : ''}
              {r.updatedAt && r.phone && ` Your phone reported it ${timeAgo(r.phone.reportedAt)}.`}
            </small>
          </>
        )}

        <button className="btn ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>,
    document.body,
  );
}
