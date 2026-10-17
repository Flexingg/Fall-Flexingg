package cc.randalls.gauntlet.wallpaper;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import java.time.Instant;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Today's six fractions and the quality setting, for the wallpaper process. The app writes its
 * latest WallpaperResponse into Capacitor Preferences (src/lib/wallpaper.ts); this reads it from
 * the same SharedPreferences and calls back when it changes, so no Activity is needed.
 */
public final class WallpaperStateProvider implements SharedPreferences.OnSharedPreferenceChangeListener {
    /** Capacitor Preferences' default group. */
    static final String PREFS = "CapacitorStorage";
    static final String SNAPSHOT_KEY = "gauntlet.wallpaper";
    static final String QUALITY_KEY = "gauntlet.wallpaper.quality";
    private static final String TAG = "GalaxyWallpaper";

    public interface Listener {
        /** On the main thread. */
        void onWallpaperStateChanged();
    }

    private final SharedPreferences prefs;
    private Listener listener;
    private String parsedJson;
    private WallpaperSnapshot snapshot;

    public WallpaperStateProvider(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Start (or, with null, stop) calling back on changes. Holds the only strong reference. */
    public void setListener(Listener l) {
        if (listener == null && l != null) prefs.registerOnSharedPreferenceChangeListener(this);
        if (listener != null && l == null) prefs.unregisterOnSharedPreferenceChangeListener(this);
        listener = l;
    }

    @Override
    public void onSharedPreferenceChanged(SharedPreferences p, String key) {
        // key is null when the whole file was cleared.
        if (listener != null && (key == null || SNAPSHOT_KEY.equals(key) || QUALITY_KEY.equals(key))) {
            listener.onWallpaperStateChanged();
        }
    }

    public Quality quality() {
        return Quality.fromPref(prefs.getString(QUALITY_KEY, null));
    }

    public WallpaperSnapshot snapshot() {
        String json = prefs.getString(SNAPSHOT_KEY, null);
        if (json == null) return null;
        if (!json.equals(parsedJson)) {
            parsedJson = json;
            snapshot = parse(json);
        }
        return snapshot;
    }

    /** Calories, protein, carbs, fat, water, volume, sleep, for the person's local day as of `now`. */
    public float[] fractions(Instant now) {
        WallpaperSnapshot s = snapshot();
        return WallpaperFractions.compute(s, WallpaperFractions.today(s == null ? null : s.timezone, now));
    }

    public long millisUntilNextDay(Instant now) {
        WallpaperSnapshot s = snapshot();
        return WallpaperFractions.millisUntilNextDay(s == null ? null : s.timezone, now);
    }

    static WallpaperSnapshot parse(String json) {
        try {
            JSONObject o = new JSONObject(json);
            int n = WallpaperSnapshot.CHANNELS.length;
            double[] values = new double[n];
            double[] goals = new double[n];
            for (int i = 0; i < n; i++) {
                JSONObject c = o.optJSONObject(WallpaperSnapshot.CHANNELS[i]);
                values[i] = c == null ? Double.NaN : c.optDouble("value", Double.NaN);
                goals[i] = c == null ? Double.NaN : c.optDouble("goal", Double.NaN);
            }
            return new WallpaperSnapshot(o.optString("date"), o.optString("timezone", null), values, goals);
        } catch (JSONException e) {
            Log.w(TAG, "Ignoring an unreadable wallpaper snapshot", e);
            return null;
        }
    }
}
