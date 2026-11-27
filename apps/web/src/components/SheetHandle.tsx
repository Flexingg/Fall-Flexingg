import type { SheetDrag } from '../lib/useSheetDrag';
import '../styles/sheet.css';

/**
 * The grab bar at the top of a bottom sheet. The visible bar stays small, but the button around it
 * is a big touch target: drag it down to close, or tap / press Enter to close.
 */
export function SheetHandle({ drag }: { drag: SheetDrag }) {
  return (
    <button
      type="button"
      ref={drag.handleRef}
      className="sheet-handle"
      aria-label="Close"
      data-testid="sheet-handle"
      {...drag.handleProps}
    >
      <i aria-hidden />
    </button>
  );
}
