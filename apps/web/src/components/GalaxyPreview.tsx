import { useEffect, useRef, useState } from 'react';
import { GalaxyAnimator, GalaxyGL } from '../wallpaper/galaxy';
import { RENDER_SCALE, type WallpaperQuality } from '../lib/wallpaper';

const FPS: Record<WallpaperQuality, number> = { max: 30, balanced: 24, saver: 12 };

/**
 * The live wallpaper, drawn in the app. `targets` are calories, protein, carbs, fat, water and
 * volume fractions; changing `replay` plays the intro again, as unlocking the phone does.
 */
export function GalaxyPreview({
  targets,
  quality,
  replay,
}: {
  targets: readonly number[];
  quality: WallpaperQuality;
  replay: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const anim = useRef(new GalaxyAnimator());
  const gl = useRef<GalaxyGL | null>(null);
  const t0 = useRef(0);
  const latest = useRef(targets);
  const settings = useRef({ quality });
  settings.current.quality = quality;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = canvas.current!;
    try {
      gl.current = new GalaxyGL(el);
    } catch {
      setFailed(true);
      return;
    }
    const lost = (e: Event) => e.preventDefault();
    const restored = () => gl.current?.init();
    el.addEventListener('webglcontextlost', lost);
    el.addEventListener('webglcontextrestored', restored);

    const size = () => {
      const scale = (window.devicePixelRatio || 1) * RENDER_SCALE[settings.current.quality];
      el.width = Math.max(1, Math.round(el.clientWidth * scale));
      el.height = Math.max(1, Math.round(el.clientHeight * scale));
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(el);

    let raf = 0;
    let last = 0;
    let shownQuality = settings.current.quality;
    const frame = (ms: number) => {
      raf = requestAnimationFrame(frame);
      const q = settings.current.quality;
      if (q !== shownQuality) {
        shownQuality = q;
        size();
      }
      // Same frame budget as the wallpaper at this quality (small slack for vsync jitter).
      if (ms - last < 1000 / FPS[q] - 4) return;
      last = ms;
      const now = ms / 1000;
      gl.current?.draw(anim.current, now, now - t0.current);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener('webglcontextlost', lost);
      el.removeEventListener('webglcontextrestored', restored);
    };
  }, []);

  // The intro, on open and on "Replay".
  useEffect(() => {
    const now = performance.now() / 1000;
    t0.current = now;
    anim.current.intro(latest.current, now);
  }, [replay]);

  // New numbers while showing glide over from the old ones.
  useEffect(() => {
    latest.current = targets;
    anim.current.retarget(targets, performance.now() / 1000);
  }, [targets]);

  return failed ? (
    <div className="muted" style={{ padding: 24, fontSize: 13, textAlign: 'center' }}>
      This phone can't show the preview.
    </div>
  ) : (
    <canvas
      ref={canvas}
      aria-label="Live wallpaper preview"
      role="img"
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  );
}
