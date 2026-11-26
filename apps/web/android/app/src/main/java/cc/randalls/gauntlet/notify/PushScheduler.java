package cc.randalls.gauntlet.notify;

import android.content.Context;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import java.util.concurrent.TimeUnit;

/** Starts and stops the background poll. WorkManager keeps it across app restarts and reboots. */
final class PushScheduler {

    private static final String PERIODIC = "gauntlet-notification-poll";
    private static final String NOW = "gauntlet-notification-poll-now";

    private PushScheduler() {}

    private static Constraints online() {
        return new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
    }

    /** Poll every 15 minutes (Android's minimum), and once right away. */
    static void start(Context context) {
        WorkManager wm = WorkManager.getInstance(context.getApplicationContext());
        PeriodicWorkRequest periodic =
                new PeriodicWorkRequest.Builder(PollWorker.class, 15, TimeUnit.MINUTES)
                        .setConstraints(online())
                        .build();
        wm.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.UPDATE, periodic);
        OneTimeWorkRequest now =
                new OneTimeWorkRequest.Builder(PollWorker.class).setConstraints(online()).build();
        wm.enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, now);
    }

    static void stop(Context context) {
        WorkManager wm = WorkManager.getInstance(context.getApplicationContext());
        wm.cancelUniqueWork(PERIODIC);
        wm.cancelUniqueWork(NOW);
    }
}
