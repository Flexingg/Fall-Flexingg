package cc.randalls.gauntlet.wallpaper;

/**
 * Today's numbers as the app last saw them (WallpaperResponse in packages/shared). Missing values
 * and goals are NaN. Channel order: calories, protein, carbs, fat, water, volume, sleep.
 */
public final class WallpaperSnapshot {
    public static final String[] CHANNELS = {"calories", "protein", "carbs", "fat", "water", "volume", "sleep"};

    public final String date;
    public final String timezone;
    public final double[] values;
    public final double[] goals;

    public WallpaperSnapshot(String date, String timezone, double[] values, double[] goals) {
        this.date = date;
        this.timezone = timezone;
        this.values = values;
        this.goals = goals;
    }
}
