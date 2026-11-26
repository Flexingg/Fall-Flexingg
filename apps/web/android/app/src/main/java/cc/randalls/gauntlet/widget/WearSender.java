package cc.randalls.gauntlet.widget;

import android.content.Context;
import android.util.Log;
import com.google.android.gms.wearable.PutDataMapRequest;
import com.google.android.gms.wearable.PutDataRequest;
import com.google.android.gms.wearable.Wearable;

/** Best effort: puts the snapshot in the Wearable Data Layer for the watch app. Never throws. */
final class WearSender {
    static final String PATH = "/gauntlet/today";
    private static final String TAG = "GauntletWear";

    private WearSender() {}

    static void send(Context ctx, String json) {
        try {
            PutDataMapRequest map = PutDataMapRequest.create(PATH);
            map.getDataMap().putString("json", json);
            // Identical data isn't delivered again, and the tile wants to know the phone is alive.
            map.getDataMap().putLong("sentAt", System.currentTimeMillis());
            PutDataRequest request = map.asPutDataRequest().setUrgent();
            Wearable.getDataClient(ctx.getApplicationContext())
                    .putDataItem(request)
                    .addOnFailureListener(e -> Log.d(TAG, "Watch data not sent: " + e.getMessage()));
        } catch (Throwable t) {
            // No Play services (or no watch): the phone widget still works.
            Log.d(TAG, "Watch data not sent: " + t);
        }
    }
}
