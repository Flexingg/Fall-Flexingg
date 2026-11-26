/**
 * A year of one daily number as a grid (a column per week, Monday to Sunday down the side), on a
 * profile. Five levels relative to the person's own range. One cell is a tab stop at a time (arrow
 * keys move between days) so the 365 buttons don't swamp keyboard users; every cell has a label.
 */
import {
  HEATMAP_METRICS,
  addDays,
  buildWeekGrid,
  gridRow,
  heatLevel,
  heatThresholds,
  type HeatmapMetricKey,
  type HeatmapResponse,
} from '@gauntlet/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useHeatmap } from '../lib/reviewQueries';
import { ErrorBox, Skeleton } from './ui';
import '../styles/review.css';

const ROW_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', ''];

const nice = (v: number, decimals: number) =>
  v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: decimals });
const longDate = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

export function CalendarHeatmap({ userId, name }: { userId: string; name?: string }) {
  const [metric, setMetric] = useState<HeatmapMetricKey>('steps');
  const q = useHeatmap(userId, metric);
  return (
    <section>
      <div className="lbl">Calendar</div>
      <div className="card stack" style={{ gap: 12 }}>
        <div className="hm-head">
          <b style={{ fontSize: 15 }}>{name ? `${name}'s year` : 'Your year'}</b>
          <select
            className="hm-select"
            aria-label="Show on the calendar"
            value={metric}
            onChange={(e) => setMetric(e.target.value as HeatmapMetricKey)}
          >
            {HEATMAP_METRICS.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <ErrorBox error={q.error} />
        {q.isPending && <Skeleton height={130} />}
        {q.data && <Grid key={metric} data={q.data} />}
      </div>
    </section>
  );
}

function Grid({ data }: { data: HeatmapResponse }) {
  const { weeks, monthLabels } = useMemo(
    () => buildWeekGrid(data.start, data.end),
    [data.start, data.end],
  );
  const values = useMemo(() => new Map(data.days), [data.days]);
  const thresholds = useMemo(() => heatThresholds(data.days.map(([, v]) => v)), [data.days]);
  const total = useMemo(() => data.days.reduce((s, [, v]) => s + v, 0), [data.days]);

  // The tab stop (and what the readout shows): the latest day, until you pick another.
  const [active, setActive] = useState(data.end);
  const [picked, setPicked] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);

  // Start with the latest week in view on a phone.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [data.end]);

  const describe = (date: string) => {
    const v = values.get(date);
    return v
      ? `${longDate(date)}: ${nice(v, data.decimals)} ${data.unit}`
      : `${longDate(date)}: nothing recorded`;
  };

  function move(date: string, e: React.KeyboardEvent) {
    const step: Record<string, number> = {
      ArrowLeft: -7,
      ArrowRight: 7,
      ArrowUp: -1,
      ArrowDown: 1,
    };
    let next: string | null = null;
    if (e.key in step) next = addDays(date, step[e.key]!);
    else if (e.key === 'Home') next = data.start;
    else if (e.key === 'End') next = data.end;
    if (!next) return;
    e.preventDefault();
    if (next < data.start || next > data.end) return;
    setActive(next);
    setPicked(true);
    grid.current?.querySelector<HTMLButtonElement>(`[data-date="${next}"]`)?.focus();
  }

  const summary = data.days.length
    ? `${data.days.length} days with ${data.label.toLowerCase()} recorded, ${nice(total, data.decimals)} ${data.unit} in total.`
    : `No ${data.label.toLowerCase()} recorded in this time.`;

  return (
    <>
      <div className="hm-scroll" ref={scroller}>
        <div
          className="hm"
          role="group"
          aria-label={`${data.label} by day. ${summary} Use the arrow keys to move between days.`}
        >
          <div className="hm-months" aria-hidden>
            {monthLabels.map((m) => (
              <span key={m.week} style={{ left: m.week * 16 }}>
                {m.label}
              </span>
            ))}
          </div>
          <div className="hm-days" aria-hidden style={{ gridRow: 2 }}>
            {ROW_LABELS.map((l, i) => (
              <span key={i}>{l}</span>
            ))}
          </div>
          <div className="hm-grid" ref={grid} style={{ gridRow: 2, gridColumn: 2 }}>
            {weeks.flatMap((week, w) =>
              week.map((date, r) =>
                date ? (
                  <button
                    key={date}
                    type="button"
                    className="hm-cell"
                    data-date={date}
                    data-l={heatLevel(values.get(date) ?? 0, thresholds)}
                    tabIndex={date === active ? 0 : -1}
                    aria-label={describe(date)}
                    aria-pressed={picked && date === active}
                    style={{ gridRow: gridRow(date) + 1, gridColumn: w + 1 }}
                    onClick={() => {
                      setActive(date);
                      setPicked(true);
                    }}
                    onMouseEnter={() => {
                      setActive(date);
                      setPicked(true);
                    }}
                    onFocus={() => setActive(date)}
                    onKeyDown={(e) => move(date, e)}
                  />
                ) : null,
              ),
            )}
          </div>
        </div>
      </div>
      <div className="hm-read" aria-live="polite" data-testid="heatmap-readout">
        {picked ? (
          describe(active)
        ) : (
          <span className="muted">{summary} Tap a day for its number.</span>
        )}
      </div>
      <div className="hm-legend" aria-hidden>
        Less
        {[0, 1, 2, 3, 4].map((l) => (
          <i key={l} className="hm-cell" data-l={l} style={{ width: 12, height: 12 }} />
        ))}
        More
      </div>
    </>
  );
}
