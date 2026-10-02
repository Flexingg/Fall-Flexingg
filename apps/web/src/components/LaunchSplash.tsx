import { useEffect, useRef, useState } from 'react';

/**
 * The animated launch screen: a start line pinches into the logo tile, chevrons punch up, the
 * wordmark rolls in, then a loader ticks while the app signs in. It hands off to the app once the
 * animation has played and the app is ready (tap to skip once it is). Played once per app start.
 */

/** Playback speed: 1 is the design's 3.9 s; 0.8 hands off at about 3.1 s. */
const SPEED = 0.8;
const PLAY_MS = 3900 * SPEED;
const REDUCED_MS = 700;
const FADE_MS = 280;

let played = false;

/** Browser automation skips it so tests don't wait for it (`?splash=1` forces it, for its own test). */
export function shouldShowSplash(): boolean {
  if (played) return false;
  try {
    if (new URLSearchParams(window.location.search).get('splash') === '1') return true;
  } catch {
    /* no window.location.search */
  }
  return !navigator.webdriver;
}

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

export function LaunchSplash({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const [elapsed, setElapsed] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const started = useRef(performance.now());
  const done = useRef(false);
  const minMs = reduced() ? REDUCED_MS : PLAY_MS;

  useEffect(() => {
    const t = setTimeout(() => setElapsed(true), minMs);
    return () => clearTimeout(t);
  }, [minMs]);

  const finish = () => {
    if (done.current) return;
    done.current = true;
    setLeaving(true);
    setTimeout(() => {
      played = true;
      onDone();
    }, FADE_MS);
  };

  useEffect(() => {
    if (ready && elapsed) finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, elapsed]);

  return (
    <div
      className={`splash play${leaving ? ' leaving' : ''}`}
      style={{ ['--s' as string]: SPEED, ['--fade' as string]: `${FADE_MS}ms` }}
      onPointerDown={() => {
        // Tap to skip, once the logo has landed and the app is ready to show.
        if (ready && performance.now() - started.current > 1500) finish();
      }}
      role="img"
      aria-label="Gauntlet. Throw it down. Step it up."
    >
      <div className="splash-stage">
        <div className="splash-glow" />
        <div className="splash-startline" />
        {(['g1', 'g2', 'g3'] as const).map((g) => (
          <svg key={g} className={`splash-ghost ${g}`} viewBox="0 0 640 360" aria-hidden="true">
            <polygon points="20,300 320,20 620,300 620,340 320,80 20,340" />
          </svg>
        ))}
        <div className="splash-center">
          <div className="splash-icon">
            <div className="splash-pulse" />
            <svg viewBox="0 0 1000 1000" aria-hidden="true">
              <rect className="tile" x="0" y="0" width="1000" height="1000" rx="220" />
              <g>
                <polygon
                  className="chev-t"
                  points="190,405 495,110 800,405 800,505 495,215 190,505"
                />
              </g>
              <g>
                <polygon
                  className="chev-b"
                  points="190,615 495,320 800,615 800,755 495,463 190,755"
                />
              </g>
            </svg>
          </div>
          <div className="splash-wordmark" aria-hidden="true">
            {'GAUNTLET'.split('').map((c, i) => (
              <span key={i} style={{ ['--i' as string]: i }}>
                {c}
              </span>
            ))}
          </div>
          <p className="splash-tagline">
            Throw it down. <b>Step it up.</b>
          </p>
        </div>
        <div className="splash-loader" aria-hidden="true">
          <div className="splash-track">
            <div className="splash-bar" />
          </div>
          <div className="splash-sync">
            <i>Waking things up</i>
            <i>Syncing your data</i>
            <i>Loading your crew</i>
          </div>
        </div>
      </div>
    </div>
  );
}
