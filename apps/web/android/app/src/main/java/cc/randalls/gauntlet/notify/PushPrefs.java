package cc.randalls.gauntlet.notify;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Where the background job finds the Gauntlet server and this phone's device token. They live in
 * private app storage; the job runs without the web app open, so it can't ask the web layer.
 */
final class PushPrefs {

    private static final String FILE = "gauntlet_push";
    private static final String KEY_SERVER = "server_url";
    private static final String KEY_TOKEN = "device_token";

    private final SharedPreferences prefs;

    PushPrefs(Context context) {
        this.prefs = context.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    boolean isEnabled() {
        return serverUrl() != null && token() != null;
    }

    /** The server address without a trailing slash, or null when not set. */
    String serverUrl() {
        String v = prefs.getString(KEY_SERVER, null);
        return v == null || v.isEmpty() ? null : v;
    }

    String token() {
        String v = prefs.getString(KEY_TOKEN, null);
        return v == null || v.isEmpty() ? null : v;
    }

    void save(String serverUrl, String token) {
        String clean = serverUrl.trim();
        while (clean.endsWith("/")) clean = clean.substring(0, clean.length() - 1);
        prefs.edit().putString(KEY_SERVER, clean).putString(KEY_TOKEN, token).apply();
    }

    void clear() {
        prefs.edit().remove(KEY_SERVER).remove(KEY_TOKEN).apply();
    }
}
