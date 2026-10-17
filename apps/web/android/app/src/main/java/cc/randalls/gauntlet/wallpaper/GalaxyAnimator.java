package cc.randalls.gauntlet.wallpaper;

/**
 * Eases the shader inputs toward their targets: the intro each time the wallpaper is shown, then
 * a short glide when the numbers change. Same timings as src/wallpaper/galaxy.ts (the preview).
 * Times are seconds; nothing here allocates after construction.
 */
public final class GalaxyAnimator {
    /** Channel order: calories, protein, carbs, fat, water, volume, then fade. */
    public static final int CHANNELS = 7;
    public static final int FADE = 6;
    private static final float[] DELAYS = {0.2f, 0.5f, 0.8f, 1.1f, 1.4f, 1.2f, 0f};
    private static final float[] DURATIONS = {3.0f, 2.8f, 2.8f, 2.8f, 2.8f, 2.8f, 1.5f};
    static final float RETARGET_SECONDS = 1.5f;

    private final float[] from = new float[CHANNELS];
    private final float[] to = new float[CHANNELS];
    private final float[] start = new float[CHANNELS];
    private final float[] dur = new float[CHANNELS];

    public GalaxyAnimator() {
        for (int i = 0; i < CHANNELS; i++) dur[i] = 1f;
    }

    static float easeOutCubic(float x) {
        float u = 1f - x;
        return 1f - u * u * u;
    }

    /** Everything grows in from nothing. targets: the six fractions (fade is implied). */
    public void intro(float[] targets, float now) {
        for (int i = 0; i < CHANNELS; i++) {
            from[i] = 0f;
            to[i] = i == FADE ? 1f : targets[i];
            start[i] = now + DELAYS[i];
            dur[i] = DURATIONS[i];
        }
    }

    /** Glide from what's on screen to new targets; unchanged channels carry on as they were. */
    public void retarget(float[] targets, float now) {
        for (int i = 0; i < FADE; i++) {
            if (targets[i] == to[i]) continue;
            from[i] = value(i, now);
            to[i] = targets[i];
            start[i] = now;
            dur[i] = RETARGET_SECONDS;
        }
    }

    public float value(int i, float now) {
        float x = (now - start[i]) / dur[i];
        x = x < 0f ? 0f : (x > 1f ? 1f : x);
        return from[i] + (to[i] - from[i]) * easeOutCubic(x);
    }

    /** True once every channel has reached its target. */
    public boolean settled(float now) {
        for (int i = 0; i < CHANNELS; i++) if (now < start[i] + dur[i]) return false;
        return true;
    }
}
