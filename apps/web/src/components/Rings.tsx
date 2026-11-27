/**
 * Three concentric rings, as in the Today mockup. Values are 0..1+ (a ring stops at full). Optionally
 * labelled for screen readers with what each ring is.
 */
export const RING_COLORS = ['var(--volt)', 'var(--text)', 'var(--muted)'];

export function Rings({
  values,
  size = 110,
  label = "Today's progress rings",
}: {
  values: [number, number, number];
  size?: number;
  label?: string;
}) {
  const radii = [48, 34, 20];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 110 110"
      fill="none"
      strokeLinecap="round"
      role="img"
      aria-label={label}
    >
      {radii.map((r, i) => {
        const c = 2 * Math.PI * r;
        const p = Math.min(Math.max(values[i] ?? 0, 0), 1);
        return (
          <g key={r}>
            <circle cx="55" cy="55" r={r} stroke="var(--line)" strokeWidth="10" />
            {p > 0 && (
              <circle
                cx="55"
                cy="55"
                r={r}
                stroke={RING_COLORS[i]}
                strokeWidth="10"
                strokeDasharray={c}
                strokeDashoffset={c * (1 - p)}
                transform="rotate(-90 55 55)"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}
