package cc.randalls.gauntlet.wear;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Log;
import androidx.wear.tiles.TileService;
import com.google.android.gms.wearable.DataItem;
import com.google.android.gms.wearable.DataMapItem;
import com.google.android.gms.wearable.Wearable;
import java.text.NumberFormat;
import java.time.LocalDate;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Today's snapshot as the phone sent it (the JSON of packages/shared/src/widget.ts), kept on the
 * watch so the tile and the activity can draw without the phone being nearby.
 */
final class WearData {
    static final String PATH = "/gauntlet/today";
    private static final String PREFS = "gauntlet_wear";
    private static final String KEY = "snapshot";
    private static final String TAG = "GauntletWear";

    final double steps;
    final double goal;
    final String date;
    /** "2nd of 5"; empty when there is no running challenge. */
    final String rankText;
    final String challengeName;
    final String challengeLine;

    private WearData(double steps, double goal, String date, String rankText, String name, String line) {
        this.steps = steps;
        this.goal = goal;
        this.date = date;
        this.rankText = rankText;
        this.challengeName = name;
        this.challengeLine = line;
    }

    boolean hasSteps() {
        return !Double.isNaN(steps);
    }

    boolean hasGoal() {
        return !Double.isNaN(goal) && goal > 0;
    }

    /** 0..1, capped at a full ring. */
    float fraction() {
        if (!hasSteps() || !hasGoal()) return 0f;
        return (float) Math.max(0d, Math.min(1d, steps / goal));
    }

    /** Yesterday's totals aren't today's: callers show "open on your phone" instead. */
    boolean isToday() {
        return LocalDate.now().toString().equals(date);
    }

    String stepsText() {
        return hasSteps() ? NumberFormat.getIntegerInstance().format(Math.round(steps)) : "–";
    }

    String goalText() {
        return hasGoal() ? "of " + NumberFormat.getIntegerInstance().format(Math.round(goal)) : "steps";
    }

    static WearData parse(String json) throws JSONException {
        JSONObject root = new JSONObject(json);
        JSONObject steps = root.optJSONObject("steps");
        double value = Double.NaN;
        double goal = Double.NaN;
        if (steps != null) {
            if (!steps.isNull("value")) value = steps.optDouble("value", Double.NaN);
            if (!steps.isNull("goal")) goal = steps.optDouble("goal", Double.NaN);
        }
        String rank = "";
        String name = "";
        String line = "";
        JSONObject c = root.optJSONObject("challenge");
        if (c != null) {
            rank = c.optString("rankText", "");
            name = c.optString("name", "");
            line = c.optString("line", "");
        }
        return new WearData(value, goal, root.optString("date", ""), rank, name, line);
    }

    /** Null before the phone has sent anything. */
    static WearData load(Context ctx) {
        String json = prefs(ctx).getString(KEY, null);
        if (json == null) return null;
        try {
            return parse(json);
        } catch (JSONException e) {
            return null;
        }
    }

    /** Stores a snapshot from the phone and redraws the tile. Returns false if it isn't usable. */
    static boolean save(Context ctx, String json) {
        try {
            parse(json);
        } catch (JSONException e) {
            return false;
        }
        prefs(ctx).edit().putString(KEY, json).apply();
        requestTileUpdate(ctx);
        return true;
    }

    static void requestTileUpdate(Context ctx) {
        try {
            TileService.getUpdater(ctx.getApplicationContext()).requestUpdate(GauntletTileService.class);
        } catch (RuntimeException e) {
            Log.d(TAG, "Tile update not requested: " + e);
        }
    }

    /** Picks up a snapshot the phone sent while nothing was listening (e.g. before the tile was added). */
    static void refreshFromDataLayer(Context ctx) {
        final Context app = ctx.getApplicationContext();
        try {
            Uri uri = new Uri.Builder().scheme("wear").path(PATH).build();
            Wearable.getDataClient(app)
                    .getDataItems(uri)
                    .addOnSuccessListener(buffer -> {
                        try {
                            for (DataItem item : buffer) {
                                String json = DataMapItem.fromDataItem(item).getDataMap().getString("json");
                                if (json != null) save(app, json);
                            }
                        } finally {
                            buffer.release();
                        }
                    })
                    .addOnFailureListener(e -> Log.d(TAG, "Couldn't read phone data: " + e.getMessage()));
        } catch (RuntimeException e) {
            Log.d(TAG, "Couldn't read phone data: " + e);
        }
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
