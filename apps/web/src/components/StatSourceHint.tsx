/**
 * The one-line "Press and hold a stat to see where it came from" tip under the day screen's rings.
 * It can be dismissed (remembered on the device). The same sentence is always in the page for screen
 * readers: stat rows point at it with aria-describedby (STAT_HINT_ID).
 */
import { useEffect, useState } from 'react';
import { storage } from '../lib/storage';
import '../styles/statSource.css';

export const STAT_HINT_ID = 'stat-source-hint';
const KEY = 'gauntlet.statSourceHint.dismissed';
const TEXT = 'Press and hold a stat to see where it came from';

export function StatSourceHint() {
  // Hidden until we know it was not dismissed, so it never flashes in and out.
  const [show, setShow] = useState(false);
  useEffect(() => {
    let live = true;
    void storage.get(KEY).then((v) => live && setShow(v !== '1'));
    return () => {
      live = false;
    };
  }, []);
  return (
    <>
      <span id={STAT_HINT_ID} className="sr-only">
        {TEXT}. With a keyboard, focus the stat and press the Menu key or Shift and F10.
      </span>
      {show && (
        <div className="ss-hint" data-testid="stat-source-tip">
          <span aria-hidden>{TEXT}</span>
          <button
            type="button"
            aria-label="Dismiss tip"
            onClick={() => {
              setShow(false);
              void storage.set(KEY, '1');
            }}
          >
            Got it
          </button>
        </div>
      )}
    </>
  );
}
