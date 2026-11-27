package cc.randalls.gauntlet.widget;

import java.text.NumberFormat;
import org.json.JSONArray;
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

    /**
     * One of the three rings the person chose (outer first): its own label ("Steps", "Distance") and
     * the value and goal as the app already formatted them in the person's units ("5.2 mi").
     */
    public static final class Ring {
        public final String label;
        public final String valueText;
        /** Without "of": "10,000" or "6.2 mi". Empty when the ring has no goal. */
        public final String goalText;
        public final Channel channel;

        Ring(String label, String valueText, String goalText, Channel channel) {
            this.label = label;
            this.valueText = valueText;
            this.goalText = goalText;
            this.channel = channel;
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
    /** Always three: the rings the person chose, or steps, active kcal and active min from older apps. */
    public final Ring[] rings;
    /** Null when there is no running featured challenge. */
    public final Challenge challenge;

    private WidgetData(
            long updatedAtMillis,
            String date,
            Channel steps,
            Channel cal,
            Channel min,
            Ring[] rings,
            Challenge challenge) {
        this.updatedAtMillis = updatedAtMillis;
        this.date = date;
        this.steps = steps;
        this.activeCalories = cal;
        this.activeMinutes = min;
        this.rings = rings;
        this.challenge = challenge;
    }

    private static Channel channel(JSONObject root, String key) {
        JSONObject o = root.optJSONObject(key);
        if (o == null) return new Channel(Double.NaN, Double.NaN);
        double value = o.isNull("value") ? Double.NaN : o.optDouble("value", Double.NaN);
        double goal = o.isNull("goal") ? Double.NaN : o.optDouble("goal", Double.NaN);
        return new Channel(value, goal);
    }

    private static String plain(double v) {
        return NumberFormat.getIntegerInstance().format(Math.round(v));
    }

    /** A ring from older snapshots (no "rings" array): the channel with a fixed label. */
    private static Ring legacyRing(String label, Channel c) {
        return new Ring(label, c.hasValue() ? plain(c.value) : "–", c.hasGoal() ? plain(c.goal) : "", c);
    }

    private static Ring[] parseRings(JSONObject root, Channel steps, Channel cal, Channel min) {
        Ring[] legacy = {
            legacyRing("Steps", steps), legacyRing("Active kcal", cal), legacyRing("Active min", min)
        };
        JSONArray arr = root.optJSONArray("rings");
        if (arr == null || arr.length() < 3) return legacy;
        Ring[] out = new Ring[3];
        for (int i = 0; i < 3; i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) return legacy;
            double value = o.isNull("value") ? Double.NaN : o.optDouble("value", Double.NaN);
            double goal = o.isNull("goal") ? Double.NaN : o.optDouble("goal", Double.NaN);
            Channel c = new Channel(value, goal);
            String label = o.optString("label", "");
            if (label.isEmpty()) label = legacy[i].label;
            String valueText = o.optString("valueText", "");
            if (valueText.isEmpty()) valueText = c.hasValue() ? plain(value) : "–";
            String goalText = o.optString("goalText", "");
            if (goalText.isEmpty() && c.hasGoal()) goalText = plain(goal);
            out[i] = new Ring(label, valueText, c.hasGoal() ? goalText : "", c);
        }
        return out;
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
        Channel steps = channel(root, "steps");
        Channel cal = channel(root, "activeCalories");
        Channel min = channel(root, "activeMinutes");
        return new WidgetData(
                updated,
                root.optString("date", ""),
                steps,
                cal,
                min,
                parseRings(root, steps, cal, min),
                challenge);
    }
}
