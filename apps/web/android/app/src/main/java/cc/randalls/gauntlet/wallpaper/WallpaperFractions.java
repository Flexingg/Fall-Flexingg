package cc.randalls.gauntlet.wallpaper;

import java.time.DateTimeException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;

/**
 * What the shader is fed: value / goal for each channel, clamped to [0, 1.25]. Mirrors
 * wallpaperFractions in packages/shared/src/wallpaper.ts.
 */
public final class WallpaperFractions {
    public static final float MAX = 1.25f;
    /** Sleep fills the sky at 8 hours; more draws the same. */
    static final int SLEEP = 6;

    private WallpaperFractions() {}

    /** No goal (or a zero one) draws nothing; a small overshoot shows, more is capped. */
    public static float fraction(double value, double goal) {
        return fraction(value, goal, MAX);
    }

    static float fraction(double value, double goal, float max) {
        if (!Double.isFinite(value) || !Double.isFinite(goal)) return 0f;
        if (goal <= 0) return 0f;
        double f = value / goal;
        return (float) Math.min(Math.max(f, 0), max);
    }

    /**
     * Fractions to draw on `today`. A snapshot from another day says nothing about today's intake,
     * so it draws as an empty day. No snapshot (signed out, never opened) also draws empty.
     */
    public static float[] compute(WallpaperSnapshot s, LocalDate today) {
        float[] out = new float[WallpaperSnapshot.CHANNELS.length];
        if (s == null || !today.toString().equals(s.date)) return out;
        for (int i = 0; i < out.length; i++) out[i] = fraction(s.values[i], s.goals[i], i == SLEEP ? 1f : MAX);
        return out;
    }

    /** The person's local date: in the time zone their day is counted in, else the phone's. */
    public static LocalDate today(String timezone, Instant now) {
        return now.atZone(zone(timezone)).toLocalDate();
    }

    /** Milliseconds until the next local midnight, when the galaxy should empty for a new day. */
    public static long millisUntilNextDay(String timezone, Instant now) {
        ZoneId zone = zone(timezone);
        Instant midnight = now.atZone(zone).toLocalDate().plusDays(1).atStartOfDay(zone).toInstant();
        return Math.max(0, midnight.toEpochMilli() - now.toEpochMilli());
    }

    private static ZoneId zone(String timezone) {
        try {
            return timezone == null ? ZoneId.systemDefault() : ZoneId.of(timezone);
        } catch (DateTimeException e) {
            return ZoneId.systemDefault();
        }
    }
}
