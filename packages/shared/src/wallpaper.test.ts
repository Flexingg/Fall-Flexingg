import { describe, expect, it } from 'vitest';
import type { MetricRow } from './derive.js';
import {
  buildWallpaper,
  DEFAULT_VOLUME_TARGET_KG,
  wallpaperFraction,
  wallpaperFractions,
} from './wallpaper.js';

// Thu 2026-10-01; the same weekday back 8 weeks is Thu 2026-08-06.
const today = '2026-10-01';
const row = (date: string, metric: string, value: number): MetricRow => ({ date, metric, value });

describe('buildWallpaper', () => {
  it("reads today's values and the latest goal up to today", () => {
    const w = buildWallpaper(
      [
        row(today, 'calories_in', 1800),
        row('2026-09-30', 'calories_in', 2500),
        row('2026-09-28', 'goal_calories', 2400),
        row('2026-09-30', 'goal_calories', 2200),
        row('2026-10-02', 'goal_calories', 9999),
        row(today, 'protein', 120),
        row(today, 'goal_protein', 150),
        row(today, 'water', 1.5),
        row('2026-09-01', 'goal_water', 2.5),
      ],
      today,
      'Europe/London',
    );
    expect(w.date).toBe(today);
    expect(w.timezone).toBe('Europe/London');
    expect(w.calories).toEqual({ value: 1800, goal: 2200 });
    expect(w.protein).toEqual({ value: 120, goal: 150 });
    expect(w.carbs).toEqual({ value: null, goal: null });
    expect(w.water).toEqual({ value: 1.5, goal: 2.5 });
  });

  it('targets the best same-weekday volume of the last 8 weeks', () => {
    const w = buildWallpaper(
      [
        row(today, 'lift_volume', 4000),
        row('2026-09-24', 'lift_volume', 6000),
        row('2026-08-06', 'lift_volume', 7000), // 8 weeks back: counts
        row('2026-07-30', 'lift_volume', 9000), // 9 weeks back: too old
        row('2026-09-29', 'lift_volume', 8000), // a Tuesday: other weekday
      ],
      today,
      'UTC',
    );
    expect(w.volume).toEqual({ value: 4000, goal: 7000 });
    expect(w.volumeGoalSource).toBe('best_weekday');
  });

  it('falls back to a constant volume target', () => {
    const w = buildWallpaper([row(today, 'lift_volume', 2500)], today, 'UTC');
    expect(w.volume).toEqual({ value: 2500, goal: DEFAULT_VOLUME_TARGET_KG });
    expect(w.volumeGoalSource).toBe('default');
  });
});

describe('wallpaperFraction', () => {
  it('divides and clamps to [0, 1.25]', () => {
    expect(wallpaperFraction(50, 100)).toBe(0.5);
    expect(wallpaperFraction(110, 100)).toBeCloseTo(1.1);
    expect(wallpaperFraction(400, 100)).toBe(1.25);
    expect(wallpaperFraction(-5, 100)).toBe(0);
  });

  it('draws nothing without a usable goal or value', () => {
    expect(wallpaperFraction(50, 0)).toBe(0);
    expect(wallpaperFraction(50, -10)).toBe(0);
    expect(wallpaperFraction(50, null)).toBe(0);
    expect(wallpaperFraction(null, 100)).toBe(0);
    expect(wallpaperFraction(Number.NaN, 100)).toBe(0);
  });
});

describe('wallpaperFractions', () => {
  const snap = buildWallpaper(
    [
      row(today, 'calories_in', 1000),
      row(today, 'goal_calories', 2000),
      row(today, 'fat', 200),
      row(today, 'goal_fat', 50),
    ],
    today,
    'UTC',
  );

  it('uses the snapshot on its own day', () => {
    expect(wallpaperFractions(snap, today)).toEqual({
      calories: 0.5,
      protein: 0,
      carbs: 0,
      fat: 1.25,
      water: 0,
      volume: 0,
    });
  });

  it("shows an empty day once the person's local day has moved on", () => {
    expect(Object.values(wallpaperFractions(snap, '2026-10-02'))).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
