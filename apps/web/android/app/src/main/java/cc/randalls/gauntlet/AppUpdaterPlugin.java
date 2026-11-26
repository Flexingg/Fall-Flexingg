package cc.randalls.gauntlet;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * Self-update for the sideloaded APK (src/lib/appUpdate.ts): downloads a release from the Gauntlet
 * server, checks its SHA-256, and opens Android's installer. Android shows its own confirmation and
 * only accepts the update if it's signed with the same key, so a bad file can't replace the app.
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {

    private static final String APK_TYPE = "application/vnd.android.package-archive";
    private volatile boolean busy = false;

    /** Whether this app may open the installer (Android 8+ asks once per app). */
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject out = new JSObject();
        out.put("allowed", canRequestInstalls());
        call.resolve(out);
    }

    /** The system screen where the person allows Gauntlet to install updates. */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            call.resolve();
            return;
        }
        Intent intent = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName()));
        try {
            getActivity().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("This phone doesn't offer that setting.", "unsupported");
        }
    }

    /** Download { url, sha256? }, emitting "progress" { downloaded, total }, then open the installer. */
    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url");
        String expected = call.getString("sha256", "");
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            call.reject("A download address is required.", "bad_url");
            return;
        }
        if (!canRequestInstalls()) {
            call.reject("Allow Gauntlet to install updates first.", "install_not_allowed");
            return;
        }
        if (busy) {
            call.reject("An update is already downloading.", "busy");
            return;
        }
        busy = true;
        new Thread(() -> {
            try {
                File apk = download(url, expected == null ? "" : expected.trim().toLowerCase());
                Uri uri = FileProvider.getUriForFile(
                        getContext(), getContext().getPackageName() + ".fileprovider", apk);
                Intent install = new Intent(Intent.ACTION_VIEW)
                        .setDataAndType(uri, APK_TYPE)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().startActivity(install);
                call.resolve();
            } catch (ChecksumException e) {
                call.reject(e.getMessage(), "checksum");
            } catch (Exception e) {
                call.reject("Couldn't download the update: " + e.getMessage(), "download_failed");
            } finally {
                busy = false;
            }
        }, "gauntlet-update").start();
    }

    private boolean canRequestInstalls() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                || getContext().getPackageManager().canRequestPackageInstalls();
    }

    private File download(String address, String expected) throws Exception {
        File dir = new File(getContext().getCacheDir(), "updates");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("no space for the download");
        File part = new File(dir, "gauntlet-update.apk.part");
        File done = new File(dir, "gauntlet-update.apk");

        HttpURLConnection conn = (HttpURLConnection) new URL(address).openConnection();
        conn.setConnectTimeout(15_000);
        conn.setReadTimeout(30_000);
        conn.setInstanceFollowRedirects(true);
        try {
            int status = conn.getResponseCode();
            if (status != 200) throw new Exception("the server answered " + status);
            long total = conn.getContentLengthLong();
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            long downloaded = 0;
            long lastEmit = 0;
            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) != -1) {
                    out.write(buf, 0, n);
                    sha.update(buf, 0, n);
                    downloaded += n;
                    long now = System.currentTimeMillis();
                    if (now - lastEmit > 200) {
                        lastEmit = now;
                        emitProgress(downloaded, total);
                    }
                }
            }
            emitProgress(downloaded, total);
            String actual = hex(sha.digest());
            if (!expected.isEmpty() && !expected.equals(actual)) {
                part.delete();
                throw new ChecksumException("The download was damaged (checksum mismatch). Try again.");
            }
            if (done.exists() && !done.delete()) throw new Exception("couldn't replace the old download");
            if (!part.renameTo(done)) throw new Exception("couldn't save the download");
            return done;
        } finally {
            conn.disconnect();
        }
    }

    private void emitProgress(long downloaded, long total) {
        JSObject p = new JSObject();
        p.put("downloaded", downloaded);
        p.put("total", total);
        notifyListeners("progress", p);
    }

    private static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    private static class ChecksumException extends Exception {
        ChecksumException(String msg) {
            super(msg);
        }
    }
}
