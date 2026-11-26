import { useEffect, useRef, useState } from 'react';

/**
 * The animated launch screen: a start line pinches into the logo tile, chevrons punch up and the
 * wordmark rolls in. Then, with everything else holding still, only the action word changes:
 * "Step it up." holds for a beat, then the word rattles through burn, lift, run, eat, drink, fast,
 * sleep. A giant "THROW IT DOWN" is hurled onto the screen like a gauntlet, lands, then drives on
 * down to the bottom, wiping the splash away as the app fades in behind it. If the app isn't ready
 * yet it waits, landed, until it is (tap to skip once it is). Played once per app start.
 *
 * The timeline lives in global.css (intro in design seconds × --s, then real seconds from --t);
 * keep THROW_AT_MS / PLAY_MS in step with it.
 */

/** The action words, in order. The first shows as the line appears. */
export const SPLASH_WORDS = ['Step', 'Burn', 'Lift', 'Run', 'Eat', 'Drink', 'Fast', 'Sleep'];

/** Intro speed: 1 is the design timeline; 0.2 forms the logo and "Step it up." in about 0.7 s. */
const SPEED = 0.2;
/** How long "Step it up." holds before the words start changing. */
const HOLD_MS = 500;
/** When THROW IT DOWN is thrown; it lands 420 ms later and sits 250 ms before sweeping down. */
const THROW_AT_MS = 1950;
const LANDED_MS = THROW_AT_MS + 500;
/** The sweep is done and the splash fully wiped away. */
const PLAY_MS = THROW_AT_MS + 1270;
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
  const [landed, setLanded] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const started = useRef(performance.now());
  const done = useRef(false);
  const still = reduced();

  // Reduced motion shows one still frame for a moment; otherwise note when the throw has landed,
  // so the sweep can wait there for the app.
  useEffect(() => {
    const t = setTimeout(() => setLanded(true), still ? REDUCED_MS : LANDED_MS);
    return () => clearTimeout(t);
  }, [still]);

  const end = () => {
    if (done.current) return;
    done.current = true;
    played = true;
    onDone();
  };
  /** Skip, or the still frame: fade out rather than wipe. */
  const finish = () => {
    if (done.current) return;
    setLeaving(true);
    setTimeout(end, FADE_MS);
  };

  useEffect(() => {
    if (!ready || hold()) return;
    if (still) {
      if (landed) finish();
      return;
    }
    // The wipe ends it (see onAnimationEnd); this is only a safety net if that event never comes.
    const t = setTimeout(finish, PLAY_MS + 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, landed, still]);

  const waiting = landed && !ready;
  return (
    <div
      className={`splash play${leaving ? ' leaving' : ''}${waiting ? ' waiting' : ''}`}
      style={{
        ['--s' as string]: SPEED,
        ['--hold' as string]: `${HOLD_MS}ms`,
        ['--t' as string]: `${THROW_AT_MS}ms`,
        ['--fade' as string]: `${FADE_MS}ms`,
      }}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && e.animationName === 'sp-wipe' && !hold()) end();
      }}
      onPointerDown={() => {
        // Tap to skip, once the logo has formed and the app is ready to show.
        if (ready && performance.now() - started.current > 600) finish();
      }}
      role="img"
      aria-label={`Gauntlet. Throw it down. ${SPLASH_WORDS.map((w) => `${w} it up.`).join(' ')}`}
    >
      {/* Behind the splash: the app shows through where it has been wiped, dimmed at first. */}
      <div className="splash-veil" />
      <div className="splash-bg">
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
                    className={
                      k === 0 ? 'first' : k === SPLASH_WORDS.length - 1 ? 'last' : undefined
                    }
                    style={{ ['--k' as string]: k }}
                  >
                    {w}
                  </b>
                ))}
              </span>{' '}
              it up.
            </p>
          </div>
          <div className="splash-wait" aria-hidden="true">
            Loading your crew<span>.</span>
            <span>.</span>
            <span>.</span>
          </div>
        </div>
      </div>
      {/* In front: THROW IT DOWN, riding the wipe's edge down the screen. */}
      <div className="splash-edge" />
      <div className="splash-fg">
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
      </div>
    </div>
  );
}
