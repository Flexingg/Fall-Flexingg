import { useEffect, useRef, useState } from 'react';

/**
 * The animated launch screen: a start line pinches into the logo tile, chevrons punch up and the
 * wordmark rolls in. Then, with everything else holding still, only the action word changes:
 * "Step it up." → burn, lift, run, eat, drink, fast, sleep. The line fades and a giant
 * "THROW IT DOWN" is hurled onto the screen like a gauntlet. It hands off to the app once that has
 * played and the app is ready (tap to skip once it is). Played once per app start.
 *
 * The timeline lives in global.css (design seconds × --s); keep PLAY_MS in step with it.
 */

/** The action words, in order. The first shows as the line appears. */
export const SPLASH_WORDS = ['Step', 'Burn', 'Lift', 'Run', 'Eat', 'Drink', 'Fast', 'Sleep'];

/** Playback speed: 1 is the design timeline (8.6 s); 0.2 hands off at about 1.7 s. */
const SPEED = 0.2;
const PLAY_MS = 8600 * SPEED;
const REDUCED_MS = 700;
const FADE_MS = 200;

let played = false;

/** `?splash=hold` (tests only): stay until tapped, so frames can be inspected at exact times. */
const hold = () => {
  try {
    return new URLSearchParams(window.location.search).get('splash') === 'hold';
  } catch {
    return false;
  }
};

/** Browser automation skips it so tests don't wait for it (`?splash=1` forces it, for its own test). */
export function shouldShowSplash(): boolean {
  if (played) return false;
  try {
    const q = new URLSearchParams(window.location.search).get('splash');
    if (q === '1' || q === 'hold') return true;
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
    if (ready && elapsed && !hold()) finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, elapsed]);

  return (
    <div
      className={`splash play${leaving ? ' leaving' : ''}${elapsed && !ready ? ' waiting' : ''}`}
      style={{ ['--s' as string]: SPEED, ['--fade' as string]: `${FADE_MS}ms` }}
      onPointerDown={() => {
        // Tap to skip, once the logo has landed and the app is ready to show.
        if (ready && performance.now() - started.current > 600) finish();
      }}
      role="img"
      aria-label={`Gauntlet. Throw it down. ${SPLASH_WORDS.map((w) => `${w} it up.`).join(' ')}`}
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
          {/* Only the word moves: it sits in a slot as wide as the widest word, right-aligned, so
              " it up." never shifts. */}
          <p className="splash-tagline" aria-hidden="true">
            <span className="splash-words">
              {SPLASH_WORDS.map((w, k) => (
                <b
                  key={w}
                  className={k === 0 ? 'first' : k === SPLASH_WORDS.length - 1 ? 'last' : undefined}
                  style={{ ['--k' as string]: k }}
                >
                  {w}
                </b>
              ))}
            </span>{' '}
            it up.
          </p>
        </div>
        <div className="splash-throw" aria-hidden="true">
          <div className="splash-impact" />
          <div className="splash-dust">
            {[-3, -2, -1, 1, 2, 3].map((d) => (
              <i key={d} style={{ ['--d' as string]: d }} />
            ))}
          </div>
          <b>
            Throw it
            <br />
            down
          </b>
        </div>
        <div className="splash-wait" aria-hidden="true">
          Loading your crew<span>.</span>
          <span>.</span>
          <span>.</span>
        </div>
      </div>
    </div>
  );
}
