package cc.randalls.gauntlet.wallpaper;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

import java.time.Instant;
import java.time.LocalDate;
import org.junit.Test;

public class WallpaperFractionsTest {
    private static final double NA = Double.NaN;

    private static WallpaperSnapshot snap(String date, String tz) {
        // calories, protein, carbs, fat, water, volume, sleep
        return new WallpaperSnapshot(
                date,
                tz,
                new double[] {1100, 75, 400, 70, 1.5, 9000, 10},
                new double[] {2200, 150, 200, 0, NA, 6000, 8});
    }

    @Test
    public void dividesAndClamps() {
        assertEquals(0.5f, WallpaperFractions.fraction(50, 100), 1e-6);
        assertEquals(1.1f, WallpaperFractions.fraction(110, 100), 1e-6);
        assertEquals(1.25f, WallpaperFractions.fraction(400, 100), 0);
        assertEquals(0f, WallpaperFractions.fraction(-5, 100), 0);
    }

    @Test
    public void noGoalOrValueDrawsNothing() {
        assertEquals(0f, WallpaperFractions.fraction(50, 0), 0);
        assertEquals(0f, WallpaperFractions.fraction(50, -10), 0);
        assertEquals(0f, WallpaperFractions.fraction(50, NA), 0);
        assertEquals(0f, WallpaperFractions.fraction(NA, 100), 0);
        assertEquals(0f, WallpaperFractions.fraction(Double.POSITIVE_INFINITY, 100), 0);
    }

    @Test
    public void usesTheSnapshotOnItsOwnDay() {
        float[] f = WallpaperFractions.compute(snap("2026-10-01", "UTC"), LocalDate.parse("2026-10-01"));
        assertArrayEquals(new float[] {0.5f, 0.5f, 1.25f, 0f, 0f, 1.25f, 1f}, f, 1e-6f);
    }

    @Test
    public void aNewDayStartsEmpty() {
        float[] f = WallpaperFractions.compute(snap("2026-10-01", "UTC"), LocalDate.parse("2026-10-02"));
        assertArrayEquals(new float[7], f, 0);
        assertArrayEquals(new float[7], WallpaperFractions.compute(null, LocalDate.parse("2026-10-02")), 0);
    }

    @Test
    public void theDayIsCountedInThePersonsTimeZone() {
        Instant late = Instant.parse("2026-10-02T03:30:00Z"); // 22:30 on Oct 1 in Chicago
        assertEquals(LocalDate.parse("2026-10-01"), WallpaperFractions.today("America/Chicago", late));
        assertEquals(LocalDate.parse("2026-10-02"), WallpaperFractions.today("Europe/Berlin", late));
        // Still Oct 1 in Chicago, so a Chicago snapshot from Oct 1 still counts.
        WallpaperSnapshot s = snap("2026-10-01", "America/Chicago");
        assertEquals(0.5f, WallpaperFractions.compute(s, WallpaperFractions.today(s.timezone, late))[0], 1e-6);
    }

    @Test
    public void countsDownToLocalMidnight() {
        Instant late = Instant.parse("2026-10-02T03:30:00Z");
        assertEquals(90 * 60_000L, WallpaperFractions.millisUntilNextDay("America/Chicago", late));
    }

    @Test
    public void anUnknownZoneFallsBackToThePhones() {
        Instant now = Instant.parse("2026-10-02T12:00:00Z");
        assertEquals(WallpaperFractions.today(null, now), WallpaperFractions.today("Not/AZone", now));
    }
}
