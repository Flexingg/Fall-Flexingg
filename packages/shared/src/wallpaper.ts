/**
 * What the Android "health galaxy" live wallpaper shows: today's food, water and lifting as
 * fractions of the person's own goals. Built from the same daily rows as Today and Trends.
 */
import type { WallpaperChannel, WallpaperResponse } from './api.js';
import { addDays } from './dates.js';
import type { MetricRow } from './derive.js';

/** A small overshoot still shows; anything past this is drawn the same. */
export const WALLPAPER_MAX_FRACTION = 1.25;
/** Volume target when there's no lifting on the same weekday in the last 8 weeks. */
export const DEFAULT_VOLUME_TARGET_KG = 5000;
const VOLUME_LOOKBACK_WEEKS = 8;
/** Earliest day buildWallpaper reads, relative to today. */
export const WALLPAPER_HISTORY_DAYS = VOLUME_LOOKBACK_WEEKS * 7;

export interface WallpaperFractions {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  water: number;
  volume: number;
}

export function buildWallpaper(
  rows: MetricRow[],
  today: string,
  timezone: string,
): WallpaperResponse {
  const value = (m: string) => rows.find((r) => r.date === today && r.metric === m)?.value ?? null;
  // Goals are only stored for days something was logged, so use the latest one up to today.
  const goal = (m: string) => {
    let best: MetricRow | null = null;
    for (const r of rows)
      if (r.metric === m && r.date <= today && (!best || r.date > best.date)) best = r;
    return best?.value ?? null;
  };
  const channel = (m: string, g: string): WallpaperChannel => ({ value: value(m), goal: goal(g) });

  const sameWeekday = new Set(
    Array.from({ length: VOLUME_LOOKBACK_WEEKS }, (_, i) => addDays(today, -7 * (i + 1))),
  );
  let best = 0;
  for (const r of rows)
    if (r.metric === 'lift_volume' && sameWeekday.has(r.date)) best = Math.max(best, r.value);

  return {
    date: today,
    timezone,
    calories: channel('calories_in', 'goal_calories'),
    protein: channel('protein', 'goal_protein'),
    carbs: channel('carbs', 'goal_carbs'),
    fat: channel('fat', 'goal_fat'),
    water: channel('water', 'goal_water'),
    volume: { value: value('lift_volume'), goal: best > 0 ? best : DEFAULT_VOLUME_TARGET_KG },
    volumeGoalSource: best > 0 ? 'best_weekday' : 'default',
  };
}

/** value / goal, clamped to [0, 1.25]. No goal (or a zero one) draws nothing. */
export function wallpaperFraction(value: number | null, goal: number | null): number {
  if (value == null || goal == null || !Number.isFinite(value) || !Number.isFinite(goal)) return 0;
  if (goal <= 0) return 0;
  return Math.min(Math.max(value / goal, 0), WALLPAPER_MAX_FRACTION);
}

/**
 * Fractions to draw on `today` (the person's local date). A snapshot taken on another day says
 * nothing about today's intake, so it draws as an empty day.
 */
export function wallpaperFractions(s: WallpaperResponse, today: string): WallpaperFractions {
  const f = (c: WallpaperChannel) => (s.date === today ? wallpaperFraction(c.value, c.goal) : 0);
  return {
    calories: f(s.calories),
    protein: f(s.protein),
    carbs: f(s.carbs),
    fat: f(s.fat),
    water: f(s.water),
    volume: f(s.volume),
  };
}
