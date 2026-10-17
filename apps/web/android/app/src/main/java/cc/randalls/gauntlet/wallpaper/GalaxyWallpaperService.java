package cc.randalls.gauntlet.wallpaper;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.res.Configuration;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.service.wallpaper.WallpaperService;
import android.util.Log;
import android.view.SurfaceHolder;
import androidx.core.content.ContextCompat;
import java.io.IOException;
import java.time.Instant;
import java.util.HashSet;
import java.util.Set;

/**
 * The "health galaxy" live wallpaper: today's calories, macros, water and lifting drawn as a
 * spiral galaxy. Numbers come from the app (WallpaperStateProvider); drawing happens on a
 * GalaxyRenderThread per engine, only while visible.
 */
public class GalaxyWallpaperService extends WallpaperService {
    private static final String TAG = "GalaxyWallpaper";
    private final Set<GalaxyEngine> engines = new HashSet<>();
    private String shader;

    @Override
    public Engine onCreateEngine() {
        return new GalaxyEngine();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // A rotation or fold changes the full-size surface a scaled-down one is based on.
        for (GalaxyEngine e : engines) e.remeasure();
    }

    private String shader() {
        if (shader == null) {
            try {
                shader = GalaxyRenderer.loadShader(this);
            } catch (IOException e) {
                Log.e(TAG, "Missing " + GalaxyRenderer.SHADER_ASSET, e);
                shader = "";
            }
        }
        return shader;
    }

    final class GalaxyEngine extends Engine implements WallpaperStateProvider.Listener {
        private final Handler main = new Handler(Looper.getMainLooper());
        private final Runnable newDay = this::onWallpaperStateChanged;
        private WallpaperStateProvider state;
        private GalaxyRenderThread render;
        private PowerManager power;
        private Quality quality;

        /** Size the surface would be without scaling; 0 until the first layout. */
        private int fullWidth;
        private int fullHeight;
        private boolean fixed;
        private int fixedWidth;
        private int fixedHeight;

        private final BroadcastReceiver powerSaveChanged = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                applyQuality();
            }
        };

        @Override
        public void onCreate(SurfaceHolder holder) {
            super.onCreate(holder);
            setTouchEventsEnabled(false);
            Context ctx = GalaxyWallpaperService.this;
            state = new WallpaperStateProvider(ctx);
            power = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            render = new GalaxyRenderThread(shader());
            ContextCompat.registerReceiver(
                    ctx,
                    powerSaveChanged,
                    new IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED),
                    ContextCompat.RECEIVER_NOT_EXPORTED);
            engines.add(this);
            applyQuality();
        }

        @Override
        public void onDestroy() {
            engines.remove(this);
            main.removeCallbacks(newDay);
            state.setListener(null);
            unregisterReceiver(powerSaveChanged);
            render.quit();
            super.onDestroy();
        }

        @Override
        public void onSurfaceCreated(SurfaceHolder holder) {
            super.onSurfaceCreated(holder);
            render.surfaceCreated(holder);
        }

        @Override
        public void onSurfaceChanged(SurfaceHolder holder, int format, int width, int height) {
            super.onSurfaceChanged(holder, format, width, height);
            if (!fixed) {
                fullWidth = width;
                fullHeight = height;
                applySize();
            }
            render.surfaceChanged(width, height);
        }

        @Override
        public void onSurfaceRedrawNeeded(SurfaceHolder holder) {
            super.onSurfaceRedrawNeeded(holder);
            render.redraw();
        }

        @Override
        public void onSurfaceDestroyed(SurfaceHolder holder) {
            render.surfaceDestroyed();
            super.onSurfaceDestroyed(holder);
        }

        @Override
        public void onVisibilityChanged(boolean visible) {
            main.removeCallbacks(newDay);
            if (visible) {
                state.setListener(this);
                applyQuality();
                Instant now = Instant.now();
                render.show(state.fractions(now));
                scheduleNewDay(now);
            } else {
                state.setListener(null);
                render.hide();
            }
        }

        /** The app saved new numbers or a new quality, or the day rolled over. */
        @Override
        public void onWallpaperStateChanged() {
            if (!isVisible()) return;
            applyQuality();
            Instant now = Instant.now();
            render.update(state.fractions(now));
            main.removeCallbacks(newDay);
            scheduleNewDay(now);
        }

        private void scheduleNewDay(Instant now) {
            main.postDelayed(newDay, state.millisUntilNextDay(now) + 1000);
        }

        private void applyQuality() {
            boolean saver = power != null && power.isPowerSaveMode();
            Quality q = Quality.effective(state.quality(), saver);
            render.setPacing(q.fps, saver);
            if (q != quality) {
                quality = q;
                applySize();
            }
        }

        /** Scaled tiers draw into a smaller surface that the system stretches to fit. */
        private void applySize() {
            SurfaceHolder holder = getSurfaceHolder();
            if (quality == null || quality.scale >= 1f) {
                if (fixed) {
                    fixed = false;
                    holder.setSizeFromLayout();
                }
                return;
            }
            if (fullWidth == 0) return;
            int w = Math.max(1, Math.round(fullWidth * quality.scale));
            int h = Math.max(1, Math.round(fullHeight * quality.scale));
            if (fixed && w == fixedWidth && h == fixedHeight) return;
            fixed = true;
            fixedWidth = w;
            fixedHeight = h;
            holder.setFixedSize(w, h);
        }

        void remeasure() {
            if (!fixed) return;
            fixed = false;
            getSurfaceHolder().setSizeFromLayout();
        }
    }
}
