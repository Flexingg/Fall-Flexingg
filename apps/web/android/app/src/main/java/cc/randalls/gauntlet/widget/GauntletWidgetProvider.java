package cc.randalls.gauntlet.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.widget.RemoteViews;
import cc.randalls.gauntlet.MainActivity;
import cc.randalls.gauntlet.R;
import java.text.NumberFormat;
import java.time.LocalDate;

/**
 * "Gauntlet today" home-screen widget: the three Today rings with their numbers and, when there is
 * room, the featured challenge. It draws whatever the app last published (WidgetStore), so numbers
 * older than a few hours are greyed out and the widget says to open Gauntlet instead of passing
 * them off as current.
 */
public class GauntletWidgetProvider extends AppWidgetProvider {

    private static final long STALE_MS = 3L * 60 * 60 * 1000;
    private static final long SHOW_AGE_MS = 15L * 60 * 1000;
    /** Wider than this (dp) and the wide layout fits. */
    private static final int WIDE_MIN_DP = 200;
    private static final int TEXT = Color.parseColor("#f2f2f0");
    private static final int TEXT_STALE = Color.parseColor("#6f6f6a");

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        for (int id : appWidgetIds) update(context, manager, id);
    }

    @Override
    public void onAppWidgetOptionsChanged(
            Context context, AppWidgetManager manager, int appWidgetId, Bundle newOptions) {
        update(context, manager, appWidgetId);
    }

    /** Redraws every placed instance (after the app publishes a new snapshot). */
    public static void updateAll(Context context) {
        Context app = context.getApplicationContext();
        AppWidgetManager manager = AppWidgetManager.getInstance(app);
        int[] ids = manager.getAppWidgetIds(new ComponentName(app, GauntletWidgetProvider.class));
        for (int id : ids) update(app, manager, id);
    }

    private static void update(Context ctx, AppWidgetManager manager, int id) {
        try {
            manager.updateAppWidget(id, build(ctx, manager, id));
        } catch (RuntimeException e) {
            // A bad snapshot must never leave the home screen with "Can't load widget".
            manager.updateAppWidget(id, new RemoteViews(ctx.getPackageName(), R.layout.widget_small));
        }
    }

    private static String number(double v) {
        return NumberFormat.getIntegerInstance().format(Math.round(v));
    }

    private static String amount(WidgetData.Channel c, boolean usable) {
        return usable && c.hasValue() ? number(c.value) : "–";
    }

    private static String ofGoal(WidgetData.Channel c, boolean usable) {
        return usable && c.hasGoal() ? "of " + number(c.goal) : "";
    }

    private static String statusText(WidgetData data, boolean stale, long now) {
        if (data == null) return "Open Gauntlet to set up";
        if (stale) return "Open Gauntlet to refresh";
        long age = now - data.updatedAtMillis;
        if (age < SHOW_AGE_MS) return "";
        long minutes = age / 60000L;
        return minutes < 60 ? "Updated " + minutes + "m ago" : "Updated " + (minutes / 60) + "h ago";
    }

    private static PendingIntent openApp(Context ctx) {
        Intent launch = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (launch == null) launch = new Intent(ctx, MainActivity.class);
        return PendingIntent.getActivity(
                ctx, 1, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Opens the app on the challenge page (the web app handles gauntlet-widget://open/c/<id>). */
    private static PendingIntent openChallenge(Context ctx, String challengeId) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("gauntlet-widget://open/c/" + challengeId));
        intent.setClass(ctx, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
                ctx, 2, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static RemoteViews build(Context ctx, AppWidgetManager manager, int id) {
        Bundle options = manager.getAppWidgetOptions(id);
        int minWidthDp = options == null ? 0 : options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0);
        boolean wide = minWidthDp >= WIDE_MIN_DP;

        WidgetData data = null;
        String json = WidgetStore.load(ctx);
        if (json != null) {
            try {
                data = WidgetData.parse(json);
            } catch (org.json.JSONException ignored) {
                data = null;
            }
        }
        long now = System.currentTimeMillis();
        boolean sameDay = data != null && LocalDate.now().toString().equals(data.date);
        boolean stale = data == null || !sameDay || data.updatedAtMillis == 0L || now - data.updatedAtMillis > STALE_MS;
        // Yesterday's numbers are not today's: show dashes rather than last night's totals.
        boolean usable = data != null && sameDay;
        int textColor = stale ? TEXT_STALE : TEXT;

        float[] fractions = usable
                ? new float[] {data.steps.fraction(), data.activeCalories.fraction(), data.activeMinutes.fraction()}
                : new float[] {0f, 0f, 0f};
        float density = ctx.getResources().getDisplayMetrics().density;
        Bitmap rings = RingsRenderer.draw(Math.round((wide ? 76 : 96) * density), fractions);

        RemoteViews rv = new RemoteViews(ctx.getPackageName(), wide ? R.layout.widget_wide : R.layout.widget_small);
        rv.setImageViewBitmap(R.id.w_rings, rings);
        rv.setOnClickPendingIntent(R.id.w_root, openApp(ctx));
        String status = statusText(data, stale, now);
        if (!wide) {
            WidgetData.Channel steps = usable ? data.steps : null;
            rv.setTextViewText(R.id.w_steps, steps != null && steps.hasValue() ? number(steps.value) : "–");
            rv.setTextColor(R.id.w_steps, textColor);
            String goal = usable ? ofGoal(data.steps, true) : "";
            rv.setTextViewText(R.id.w_steps_goal, status.isEmpty() ? (goal.isEmpty() ? "steps" : goal + " steps") : status);
            return rv;
        }
        rv.setTextViewText(R.id.w_status, status);

        rv.setTextViewText(R.id.w_row_steps, row("Steps", data == null ? null : data.steps, usable));
        rv.setTextViewText(R.id.w_row_cal, row("Active kcal", data == null ? null : data.activeCalories, usable));
        rv.setTextViewText(R.id.w_row_min, row("Active min", data == null ? null : data.activeMinutes, usable));
        rv.setTextColor(R.id.w_row_steps, textColor);
        rv.setTextColor(R.id.w_row_cal, textColor);
        rv.setTextColor(R.id.w_row_min, textColor);

        WidgetData.Challenge c = data == null ? null : data.challenge;
        if (c == null) {
            rv.setViewVisibility(R.id.w_challenge_box, android.view.View.GONE);
        } else {
            rv.setViewVisibility(R.id.w_challenge_box, android.view.View.VISIBLE);
            String head = c.rankText.isEmpty() ? c.name : c.name + " · " + c.rankText;
            rv.setTextViewText(R.id.w_challenge_name, head);
            rv.setTextViewText(R.id.w_challenge_line, c.line);
            rv.setTextColor(R.id.w_challenge_name, textColor);
            if (!c.id.isEmpty()) rv.setOnClickPendingIntent(R.id.w_challenge_box, openChallenge(ctx, c.id));
        }
        return rv;
    }

    private static String row(String label, WidgetData.Channel c, boolean usable) {
        if (c == null) return label + "  –";
        String value = amount(c, usable);
        String goal = ofGoal(c, usable);
        return goal.isEmpty() ? label + "  " + value : label + "  " + value + " " + goal;
    }
}
