import '../styles/badges.css';

/** A small "Lv 7" next to a name. Nothing at all when the server didn't send a level. */
export function LevelChip({ level }: { level?: number | null }) {
  if (!level) return null;
  return (
    <span className="lvl" aria-label={`Level ${level}`} title={`Level ${level}`}>
      Lv {level}
    </span>
  );
}
