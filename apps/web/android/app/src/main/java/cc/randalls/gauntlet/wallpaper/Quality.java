package cc.randalls.gauntlet.wallpaper;

/** Render scale and frame rate tiers, picked in the app (Live wallpaper → Quality). */
public enum Quality {
    MAX(1f, 30),
    BALANCED(0.7f, 24),
    SAVER(0.5f, 12);

    public final float scale;
    public final int fps;

    Quality(float scale, int fps) {
        this.scale = scale;
        this.fps = fps;
    }

    /** The value the app stores ("max", "balanced", "saver"); anything else is Maximum. */
    public static Quality fromPref(String value) {
        if ("balanced".equals(value)) return BALANCED;
        if ("saver".equals(value)) return SAVER;
        return MAX;
    }

    /** Battery Saver always wins. */
    public static Quality effective(Quality chosen, boolean powerSave) {
        return powerSave ? SAVER : chosen;
    }
}
