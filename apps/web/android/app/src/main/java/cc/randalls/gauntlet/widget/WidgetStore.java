package cc.randalls.gauntlet.widget;

import android.content.Context;
import android.content.SharedPreferences;

/** The latest snapshot JSON, kept where the widget can read it without the app running. */
public final class WidgetStore {
    private static final String PREFS = "gauntlet_widget";
    private static final String KEY = "snapshot";

    private WidgetStore() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static void save(Context ctx, String json) {
        prefs(ctx).edit().putString(KEY, json).apply();
    }

    /** Null before the app has ever published. */
    public static String load(Context ctx) {
        return prefs(ctx).getString(KEY, null);
    }
}
