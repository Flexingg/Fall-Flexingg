package cc.randalls.gauntlet.notify;

import android.os.Build;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Phone notifications without Google services (src/lib/push.ts). The web layer registers this phone
 * with the Gauntlet server, hands the resulting token here, and a WorkManager job (PollWorker) then
 * fetches and shows new notifications every ~15 minutes, even when the app is closed.
 */
@CapacitorPlugin(
        name = "GauntletPush",
        permissions = {
            @Permission(
                    strings = {"android.permission.POST_NOTIFICATIONS"},
                    alias = GauntletPushPlugin.NOTIFICATIONS)
        })
public class GauntletPushPlugin extends Plugin {

    static final String NOTIFICATIONS = "notifications";

    /** Whether polling is on and whether Android lets Gauntlet show notifications. */
    @PluginMethod
    public void status(PluginCall call) {
        JSObject out = new JSObject();
        out.put("enabled", new PushPrefs(getContext()).isEnabled());
        out.put("permission", permission());
        call.resolve(out);
    }

    /** Ask for the notification permission (Android 13+); older versions have nothing to ask. */
    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && getPermissionState(NOTIFICATIONS) != PermissionState.GRANTED) {
            requestPermissionForAlias(NOTIFICATIONS, call, "permissionResult");
            return;
        }
        resolveGranted(call);
    }

    @PermissionCallback
    private void permissionResult(PluginCall call) {
        resolveGranted(call);
    }

    private void resolveGranted(PluginCall call) {
        JSObject out = new JSObject();
        out.put("granted", "granted".equals(permission()));
        call.resolve(out);
    }

    /** Save { serverUrl, token } and start the background job. */
    @PluginMethod
    public void enable(PluginCall call) {
        String serverUrl = call.getString("serverUrl");
        String token = call.getString("token");
        if (serverUrl == null
                || token == null
                || token.isEmpty()
                || !(serverUrl.startsWith("https://") || serverUrl.startsWith("http://"))) {
            call.reject("A server address and device token are required.", "bad_arguments");
            return;
        }
        new PushPrefs(getContext()).save(serverUrl, token);
        PushScheduler.start(getContext());
        call.resolve();
    }

    /** Stop the job and forget the token, returning it so the web layer can tell the server. */
    @PluginMethod
    public void disable(PluginCall call) {
        PushPrefs prefs = new PushPrefs(getContext());
        String token = prefs.token();
        prefs.clear();
        PushScheduler.stop(getContext());
        JSObject out = new JSObject();
        if (token != null) out.put("token", token);
        call.resolve(out);
    }

    /** "granted", "denied" or "prompt" (not asked yet). */
    private String permission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            PermissionState state = getPermissionState(NOTIFICATIONS);
            if (state == PermissionState.GRANTED) return "granted";
            if (state == PermissionState.DENIED) return "denied";
            return "prompt";
        }
        return NotificationManagerCompat.from(getContext()).areNotificationsEnabled()
                ? "granted"
                : "denied";
    }
}
