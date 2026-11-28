package cc.randalls.gauntlet;

import android.os.Build;
import androidx.activity.BackEventCompat;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.OnBackPressedDispatcher;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Android's back gesture and button for the web app (src/lib/predictiveBackNative.ts).
 *
 * The callback below is OFF until the web side says there is something for back to do (a sheet is
 * open, or there is a page to go back to). While it is off, Android handles back itself: the system
 * back-to-home animation plays and the app goes to the background like any native app. While it is
 * on, the gesture is forwarded to JS, which animates the page or sheet and then does the back:
 *   backStarted {edge, progress}, backProgress {edge, progress 0..1}, backCancelled, backInvoked.
 * Android 14+ sends the whole gesture (this needs android:enableOnBackInvokedCallback in the
 * manifest); Android 13 and below only send backInvoked, which still closes the sheet or goes back.
 *
 * Capacitor's own App plugin would register an always-on callback that blocks all of this; it is
 * switched off with disableBackButtonHandler in capacitor.config.ts.
 */
@CapacitorPlugin(name = "PredictiveBack")
public class PredictiveBackPlugin extends Plugin {

    private OnBackPressedCallback callback;

    @Override
    public void load() {
        OnBackPressedDispatcher dispatcher = getActivity().getOnBackPressedDispatcher();

        // Android 8 to 11 would finish (destroy) the app on back at the first screen. From 12 on the
        // system moves a launcher app to the background instead, so only older versions need help.
        // Added first, so the callback below (added later) always gets back before it.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            OnBackPressedCallback toBackground = new OnBackPressedCallback(true) {
                @Override
                public void handleOnBackPressed() {
                    getActivity().moveTaskToBack(true);
                }
            };
            dispatcher.addCallback(getActivity(), toBackground);
        }

        callback = new OnBackPressedCallback(false) {
            @Override
            public void handleOnBackStarted(BackEventCompat backEvent) {
                notifyListeners("backStarted", eventData(backEvent));
            }

            @Override
            public void handleOnBackProgressed(BackEventCompat backEvent) {
                notifyListeners("backProgress", eventData(backEvent));
            }

            @Override
            public void handleOnBackCancelled() {
                notifyListeners("backCancelled", new JSObject());
            }

            @Override
            public void handleOnBackPressed() {
                notifyListeners("backInvoked", new JSObject());
            }
        };
        dispatcher.addCallback(getActivity(), callback);
    }

    private static JSObject eventData(BackEventCompat backEvent) {
        JSObject data = new JSObject();
        // 0 = swiped in from the left edge, 1 = from the right.
        data.put("edge", backEvent.getSwipeEdge());
        data.put("progress", (double) backEvent.getProgress());
        return data;
    }

    /** { enabled: boolean }: should Android hand back to the web app (true) or keep it (false)? */
    @PluginMethod
    public void setEnabled(PluginCall call) {
        Boolean value = call.getBoolean("enabled", false);
        final boolean enabled = value != null && value;
        // Plugin methods run off the main thread; the back dispatcher must be updated on it.
        getActivity().runOnUiThread(() -> {
            if (callback != null) callback.setEnabled(enabled);
        });
        call.resolve();
    }
}
