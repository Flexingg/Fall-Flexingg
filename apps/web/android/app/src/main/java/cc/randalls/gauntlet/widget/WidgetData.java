package cc.randalls.gauntlet.widget;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * The snapshot the web app publishes (packages/shared/src/widget.ts, WidgetSnapshot), parsed for the
 * home-screen widget. The Wear OS module has its own small copy of this parsing.
 */
public final class WidgetData {

    /** One quantity against its target. NaN means "no value" / "no goal". */
    public static final class Channel {
        public final double value;
        public final double goal;

        Channel(double value, double goal) {
            this.value = value;
            this.goal = goal;
        }

        public boolean hasValue() {
            return !Double.isNaN(value);
        }

        public boolean hasGoal() {
            return !Double.isNaN(goal) && goal > 0;
        }

        /** 0..1 for the ring (capped at a full ring). */
        public float fraction() {
            if (!hasValue() || !hasGoal()) return 0f;
            return (float) Math.max(0d, Math.min(1d, value / goal));
        }
    }

    public static final class Challenge {
        public final String id;
        public final String name;
        public final String rankText;
        public final String line;

        Challenge(String id, String name, String rankText, String line) {
            this.id = id;
            this.name = name;
            this.rankText = rankText;
            this.line = line;
        }
    }

    public final long updatedAtMillis;
    /** The day the numbers are for, YYYY-MM-DD. */
    public final String date;
    public final Channel steps;
    public final Channel activeCalories;
    public final Channel activeMinutes;
    /** Null when there is no running featured challenge. */
    public final Challenge challenge;

    private WidgetData(
            long updatedAtMillis, String date, Channel steps, Channel cal, Channel min, Challenge challenge) {
        this.updatedAtMillis = updatedAtMillis;
        this.date = date;
        this.steps = steps;
        this.activeCalories = cal;
        this.activeMinutes = min;
        this.challenge = challenge;
    }

    private static Channel channel(JSONObject root, String key) {
        JSONObject o = root.optJSONObject(key);
        if (o == null) return new Channel(Double.NaN, Double.NaN);
        double value = o.isNull("value") ? Double.NaN : o.optDouble("value", Double.NaN);
        double goal = o.isNull("goal") ? Double.NaN : o.optDouble("goal", Double.NaN);
        return new Channel(value, goal);
    }

    public static WidgetData parse(String json) throws JSONException {
        JSONObject root = new JSONObject(json);
        long updated = 0L;
        String iso = root.optString("updatedAt", "");
        if (!iso.isEmpty()) {
            try {
                updated = java.time.Instant.parse(iso).toEpochMilli();
            } catch (RuntimeException ignored) {
                updated = 0L;
            }
        }
        Challenge challenge = null;
        JSONObject c = root.optJSONObject("challenge");
        if (c != null) {
            challenge = new Challenge(
                    c.optString("id", ""),
                    c.optString("name", ""),
                    c.optString("rankText", ""),
                    c.optString("line", ""));
        }
        return new WidgetData(
                updated,
                root.optString("date", ""),
                channel(root, "steps"),
                channel(root, "activeCalories"),
                channel(root, "activeMinutes"),
                challenge);
    }
}
