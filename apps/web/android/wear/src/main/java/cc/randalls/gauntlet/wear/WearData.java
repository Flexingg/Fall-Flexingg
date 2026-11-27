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
import org.json.JSONArray;
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
    /** The outer ring's label ("Steps", "Distance") and its value and goal as the phone formatted them. */
    final String label;
    final String valueText;
    final String goalValueText;
    /** "2nd of 5"; empty when there is no running challenge. */
    final String rankText;
    final String challengeName;
    final String challengeLine;

    private WearData(
            double steps,
            double goal,
            String date,
            String label,
            String valueText,
            String goalValueText,
            String rankText,
            String name,
            String line) {
        this.steps = steps;
        this.goal = goal;
        this.date = date;
        this.label = label;
        this.valueText = valueText;
        this.goalValueText = goalValueText;
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

    /** The outer ring's value ("6,200", "5.2 mi"). */
    String stepsText() {
        if (!hasSteps()) return "–";
        return valueText.isEmpty() ? NumberFormat.getIntegerInstance().format(Math.round(steps)) : valueText;
    }

    /** "of 10,000 steps": the goal and the ring's label, or just the label without a goal. */
    String goalText() {
        String name = label.toLowerCase();
        if (!hasGoal()) return name;
        String g = goalValueText.isEmpty()
                ? NumberFormat.getIntegerInstance().format(Math.round(goal))
                : goalValueText;
        return "of " + g + " " + name;
    }

    static WearData parse(String json) throws JSONException {
        JSONObject root = new JSONObject(json);
        // Newer phones send the three rings the person chose; the outer one is what the tile shows.
        // Older ones only have "steps".
        JSONObject steps = root.optJSONObject("steps");
        String label = "Steps";
        String valueText = "";
        String goalValueText = "";
        JSONArray rings = root.optJSONArray("rings");
        JSONObject first = rings == null ? null : rings.optJSONObject(0);
        if (first != null) {
            steps = first;
            label = first.optString("label", "Steps");
            if (label.isEmpty()) label = "Steps";
            valueText = first.optString("valueText", "");
            goalValueText = first.optString("goalText", "");
        }
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
        return new WearData(
                value, goal, root.optString("date", ""), label, valueText, goalValueText, rank, name, line);
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
