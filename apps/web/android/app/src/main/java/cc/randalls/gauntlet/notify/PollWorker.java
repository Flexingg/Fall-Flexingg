package cc.randalls.gauntlet.notify;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import cc.randalls.gauntlet.MainActivity;
import cc.randalls.gauntlet.R;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Background job: asks the Gauntlet server for notifications this phone hasn't seen and shows them.
 * Phones without Google services can't receive pushes, so they poll with a long-lived device token
 * (never the sign-in tokens, which the app rotates). The server remembers how far this device got,
 * so each notification arrives once.
 */
public class PollWorker extends Worker {

    static final String CHANNEL_ID = "gauntlet";

    public PollWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        PushPrefs prefs = new PushPrefs(context);
        String server = prefs.serverUrl();
        String token = prefs.token();
        if (server == null || token == null) return Result.success();

        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(server + "/api/push/device/poll").openConnection();
            conn.setConnectTimeout(15_000);
            conn.setReadTimeout(20_000);
            conn.setRequestProperty("Authorization", "Device " + token);
            conn.setRequestProperty("Accept", "application/json");
            int status = conn.getResponseCode();
            if (status == 401) {
                // The server no longer knows this device (signed out elsewhere, account deleted).
                prefs.clear();
                PushScheduler.stop(context);
                return Result.success();
            }
            if (status != 200) return Result.success(); // try again next period
            JSONArray list = new JSONObject(readAll(conn.getInputStream())).getJSONArray("notifications");
            for (int i = 0; i < list.length(); i++) {
                JSONObject n = list.getJSONObject(i);
                show(
                        context,
                        server,
                        n.getString("id"),
                        n.optString("title", "Gauntlet"),
                        n.optString("body", ""),
                        n.isNull("url") ? null : n.optString("url", null));
            }
            return Result.success();
        } catch (IOException e) {
            return Result.retry(); // offline or the server is down: WorkManager backs off
        } catch (Exception e) {
            return Result.success(); // an answer we couldn't read; wait for the next period
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String readAll(InputStream in) throws IOException {
        try (InputStream stream = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = stream.read(buf)) != -1) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel =
                new NotificationChannel(CHANNEL_ID, "Gauntlet", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("Challenge updates, friend requests and your weekly recap");
        nm.createNotificationChannel(channel);
    }

    /** Post one notification; tapping it opens the app at the notification's page. */
    private static void show(
            Context context, String server, String id, String title, String body, String path) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        ensureChannel(context);

        String page = path == null || path.isEmpty() ? "/notifications" : path;
        if (!page.startsWith("/")) page = "/" + page;
        // An explicit VIEW intent for the app: Capacitor's App plugin turns it into "appUrlOpen",
        // which the web layer maps to a screen (see NativeBridge in App.tsx).
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(server + page));
        open.setClass(context, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int requestCode = id.hashCode();
        PendingIntent tap =
                PendingIntent.getActivity(
                        context,
                        requestCode,
                        open,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder =
                new NotificationCompat.Builder(context, CHANNEL_ID)
                        .setSmallIcon(R.drawable.ic_stat_gauntlet)
                        .setContentTitle(title)
                        .setContentText(body)
                        .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                        .setAutoCancel(true)
                        .setContentIntent(tap)
                        .setPriority(NotificationCompat.PRIORITY_DEFAULT);
        try {
            NotificationManagerCompat.from(context).notify(requestCode, builder.build());
        } catch (SecurityException ignored) {
            // Notifications were switched off between the check and now.
        }
    }
}
