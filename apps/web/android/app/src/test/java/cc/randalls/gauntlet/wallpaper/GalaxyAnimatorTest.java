package cc.randalls.gauntlet.wallpaper;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class GalaxyAnimatorTest {
    private static final float[] TARGETS = {0.8f, 1f, 0.5f, 0.25f, 0.6f, 1.25f, 0.75f};

    @Test
    public void easesOutCubically() {
        assertEquals(0f, GalaxyAnimator.easeOutCubic(0f), 0);
        assertEquals(0.875f, GalaxyAnimator.easeOutCubic(0.5f), 1e-6);
        assertEquals(1f, GalaxyAnimator.easeOutCubic(1f), 0);
    }

    @Test
    public void introGrowsEachChannelAfterItsDelay() {
        GalaxyAnimator a = new GalaxyAnimator();
        a.intro(TARGETS, 0f);
        // Calories start at 0.2 s and take 3 s; water waits until 1.4 s.
        assertEquals(0f, a.value(0, 0.2f), 0);
        assertEquals(0.8f * 0.875f, a.value(0, 1.7f), 1e-5);
        assertEquals(0f, a.value(4, 1.39f), 0);
        assertEquals(0.6f, a.value(4, 4.3f), 1e-6);
        // Fade comes up first, over 1.5 s.
        assertEquals(1f, a.value(GalaxyAnimator.FADE, 1.5f), 0);
        assertFalse(a.settled(4.1f));
        assertFalse(a.settled(4.3f));
        assertTrue(a.settled(4.45f));
        // Sleep stars come in last, from 1.6 s over 2.8 s.
        assertEquals(0f, a.value(GalaxyAnimator.SLEEP, 1.59f), 0);
        assertEquals(0.75f, a.value(GalaxyAnimator.SLEEP, 4.45f), 1e-6);
        for (int i = 0; i < 7; i++) assertEquals(TARGETS[i], a.value(i, 10f), 1e-6);
    }

    @Test
    public void newDataGlidesFromWhatIsShowing() {
        GalaxyAnimator a = new GalaxyAnimator();
        a.intro(TARGETS, 0f);
        float[] more = TARGETS.clone();
        more[1] = 0.4f;
        float shown = a.value(1, 1f);
        a.retarget(more, 1f);
        assertEquals(shown, a.value(1, 1f), 1e-6);
        assertEquals(0.4f, a.value(1, 1f + GalaxyAnimator.RETARGET_SECONDS), 1e-6);
        // Untouched channels carry on with the intro.
        assertEquals(0f, a.value(4, 1.2f), 0);
    }

    @Test
    public void batterySaverForcesSaver() {
        assertSame(Quality.SAVER, Quality.effective(Quality.MAX, true));
        assertSame(Quality.BALANCED, Quality.effective(Quality.BALANCED, false));
        assertSame(Quality.MAX, Quality.fromPref(null));
        assertSame(Quality.SAVER, Quality.fromPref("saver"));
        assertEquals(12, Quality.SAVER.fps);
        assertEquals(0.7f, Quality.BALANCED.scale, 0);
    }
}
