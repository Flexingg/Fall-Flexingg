/** Three concentric activity rings, as in the Today mockup. Values are 0..1+. */
export function Rings({ values, size = 110 }: { values: [number, number, number]; size?: number }) {
  const colors = ['var(--volt)', 'var(--text)', 'var(--muted)'];
  const radii = [48, 34, 20];
  return (
    <svg width={size} height={size} viewBox="0 0 110 110" fill="none" strokeLinecap="round" role="img" aria-label="Today's progress rings">
      {radii.map((r, i) => {
        const c = 2 * Math.PI * r;
        const p = Math.min(Math.max(values[i] ?? 0, 0), 1);
        return (
          <g key={r}>
            <circle cx="55" cy="55" r={r} stroke="var(--line)" strokeWidth="10" />
            {p > 0 && (
              <circle cx="55" cy="55" r={r} stroke={colors[i]} strokeWidth="10" strokeDasharray={c} strokeDashoffset={c * (1 - p)} transform="rotate(-90 55 55)" />
            )}
          </g>
        );
      })}
    </svg>
  );
}
