import {
  todayIn,
  wallpaperFractions,
  weekday,
  type WallpaperChannel,
  type WallpaperResponse,
} from '@gauntlet/shared';
import { useEffect, useMemo, useState } from 'react';
import { GalaxyPreview } from '../components/GalaxyPreview';
import { ErrorBox, Header, Screen, Seg, Toggle } from '../components/ui';
import { fmtInt } from '../lib/format';
import { useWallpaper } from '../lib/queries';
import {
  GalaxyWallpaper,
  getQuality,
  QUALITY_OPTIONS,
  setQuality,
  type WallpaperQuality,
} from '../lib/wallpaper';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const amount = (c: WallpaperChannel, unit: string, decimals = 0) => {
  const f = (v: number | null) => (v == null ? '–' : decimals ? v.toFixed(decimals) : fmtInt(v));
  return `${f(c.value)} / ${c.goal ? f(c.goal) : 'no goal'} ${unit}`;
};

function legend(w: WallpaperResponse) {
  return [
    { what: 'Core', means: 'Calories', color: '#ffc77a', value: amount(w.calories, 'kcal') },
    { what: 'Coral arm', means: 'Protein', color: '#f59a7a', value: amount(w.protein, 'g') },
    { what: 'Amber arm', means: 'Carbs', color: '#fac776', value: amount(w.carbs, 'g') },
    { what: 'Violet arm', means: 'Fat', color: '#b0a8ed', value: amount(w.fat, 'g') },
    { what: 'Outer ring', means: 'Water', color: '#85b8f2', value: amount(w.water, 'L', 1) },
    { what: 'Jets', means: 'Volume lifted', color: '#8ce6cc', value: amount(w.volume, 'kg') },
  ];
}

export function WallpaperPage() {
  const wallpaper = useWallpaper();
  const [quality, setQ] = useState<WallpaperQuality>('max');
  const [showKey, setShowKey] = useState(false);
  const [replay, setReplay] = useState(0);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    getQuality().then(setQ);
    const check = () =>
      GalaxyWallpaper.status()
        .then((s) => setActive(s.active))
        .catch(() => undefined);
    check();
    // Coming back from the system picker.
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, []);

  const w = wallpaper.data;
  const targets = useMemo(() => {
    if (!w) return [0, 0, 0, 0, 0, 0];
    const f = wallpaperFractions(w, todayIn(w.timezone));
    return [f.calories, f.protein, f.carbs, f.fat, f.water, f.volume];
  }, [w]);

  async function pickQuality(q: WallpaperQuality) {
    setQ(q);
    await setQuality(q);
  }

  async function setAsWallpaper() {
    setError(null);
    try {
      await GalaxyWallpaper.open();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Screen>
      <Header title="Live wallpaper" back="/me" />
      <p className="muted" style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 14 }}>
        A slowly turning galaxy drawn from today&apos;s food, water and lifting. No numbers on your
        lock screen; the shapes grow as you get closer to your goals.
      </p>
      <ErrorBox error={wallpaper.error ?? error} />

      <div
        style={{
          position: 'relative',
          width: '62%',
          maxWidth: 260,
          aspectRatio: '228 / 468',
          margin: '0 auto',
          borderRadius: 26,
          overflow: 'hidden',
          border: '1px solid var(--line-2)',
          background: '#04050c',
        }}
      >
        <GalaxyPreview targets={targets} quality={quality} replay={replay} />
        {showKey && w && (
          <div
            className="stack"
            style={{
              position: 'absolute',
              left: 8,
              right: 8,
              bottom: 8,
              gap: 4,
              padding: '10px 12px',
              borderRadius: 14,
              background: 'rgba(12, 12, 13, 0.82)',
              fontSize: 11,
              lineHeight: 1.3,
            }}
          >
            {legend(w).map((l) => (
              <div key={l.means} className="row" style={{ gap: 6 }}>
                <i
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: l.color,
                    flex: 'none',
                  }}
                />
                <span className="grow">
                  <b>{l.what}</b> <span className="muted">{l.means}</span>
                </span>
                <span className="num">{l.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}>
        <button className="btn ghost sm" onClick={() => setReplay((n) => n + 1)}>
          Replay intro
        </button>
      </div>

      <div className="list" style={{ marginTop: 12 }}>
        <div className="item">
          <div className="grow">
            <div className="t">Show key</div>
            <small>
              What each part means, with today&apos;s numbers. Only here, never on the wallpaper.
            </small>
          </div>
          <Toggle checked={showKey} onChange={setShowKey} label="Show key" />
        </div>
      </div>

      <button className="btn" style={{ marginTop: 16, width: '100%' }} onClick={setAsWallpaper}>
        {active ? 'Set again' : 'Set as wallpaper'}
      </button>
      {active && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8, textAlign: 'center' }}>
          This is your wallpaper now.
        </p>
      )}

      <div className="lbl">Quality</div>
      <Seg value={quality} options={QUALITY_OPTIONS} onChange={pickQuality} label="Quality" />
      <p className="muted" style={{ fontSize: 12, lineHeight: 1.5, marginTop: 8 }}>
        Maximum draws at full resolution, 30 frames a second. Balanced and Saver draw smaller and
        slower to save battery. Battery Saver always uses Saver, and the galaxy holds still once the
        intro has played.
      </p>
      {w && (
        <p className="muted" style={{ fontSize: 12, lineHeight: 1.5, marginTop: 8 }}>
          The jets fill at{' '}
          {w.volumeGoalSource === 'best_weekday'
            ? `your best ${DAYS[weekday(w.date)]} of the last 8 weeks`
            : 'a default target until you log a few sessions'}
          . The wallpaper uses the numbers from the last time Gauntlet was open.
        </p>
      )}
    </Screen>
  );
}
