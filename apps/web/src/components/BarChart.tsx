import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

export interface Bar {
  date: string;
  label: string;
  value: number;
  isToday: boolean;
}

/**
 * Daily bars you can scrub: tap or drag across to pick a day, arrow keys on a keyboard, tap the
 * picked day again (or Escape) to let go. The parent shows the picked day's value.
 */
export function BarChart({
  bars,
  selected,
  onSelect,
  describe,
  label,
}: {
  /** What the chart shows, e.g. "Steps per day". */
  label: string;
  bars: Bar[];
  selected: string | null;
  onSelect: (date: string | null) => void;
  /** Spoken label for one bar, e.g. "Nov 10: 3,204 kg". */
  describe: (bar: Bar) => string;
}) {
  const plot = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const moved = useRef(false);
  const max = Math.max(...bars.map((b) => b.value), 0) || 1;
  const dense = bars.length > 10;
  const idx = bars.findIndex((b) => b.date === selected);

  const at = (clientX: number) => {
    const r = plot.current!.getBoundingClientRect();
    const i = Math.floor(((clientX - r.left) / r.width) * bars.length);
    return bars[Math.max(0, Math.min(bars.length - 1, i))]!;
  };

  const down = (e: PointerEvent) => {
    dragging.current = true;
    moved.current = false;
    plot.current!.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (!dragging.current) return;
    moved.current = true;
    const b = at(e.clientX);
    if (b.date !== selected) onSelect(b.date);
  };
  const up = (e: PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    const b = at(e.clientX);
    // A tap on the picked day lets go; a drag always ends on a day.
    onSelect(!moved.current && b.date === selected ? null : b.date);
  };

  const key = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (step) {
      e.preventDefault();
      const next = idx < 0 ? (step > 0 ? 0 : bars.length - 1) : idx + step;
      onSelect(bars[Math.max(0, Math.min(bars.length - 1, next))]!.date);
    } else if (e.key === 'Escape') onSelect(null);
  };

  return (
    <div className={`chart${dense ? ' dense' : ''}${selected ? ' picking' : ''}`}>
      <div
        ref={plot}
        className="chart-plot"
        role="listbox"
        aria-label={label}
        aria-activedescendant={idx >= 0 ? `bar-${bars[idx]!.date}` : undefined}
        tabIndex={0}
        onKeyDown={key}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => (dragging.current = false)}
      >
        {bars.map((b) => (
          <div
            key={b.date}
            id={`bar-${b.date}`}
            role="option"
            aria-selected={b.date === selected}
            aria-label={describe(b)}
            className={`chart-col${b.isToday ? ' today' : ''}${b.date === selected ? ' on' : ''}`}
          >
            <i style={{ height: b.value > 0 ? `max(4px, ${(b.value / max) * 100}%)` : '4px' }} />
          </div>
        ))}
      </div>
      <div className="chart-x" aria-hidden="true">
        {bars.map((b) => (
          <span key={b.date} className={b.date === selected ? 'on' : ''}>
            {!dense || Number(b.label) % 5 === 0 || b.date === selected ? b.label : ''}
          </span>
        ))}
      </div>
    </div>
  );
}
