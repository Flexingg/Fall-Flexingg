package cc.randalls.gauntlet.wallpaper;

import android.opengl.EGL14;
import android.opengl.EGLConfig;
import android.opengl.EGLContext;
import android.opengl.EGLDisplay;
import android.opengl.EGLSurface;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Process;
import android.util.Log;
import android.view.Choreographer;
import android.view.SurfaceHolder;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * The wallpaper's GL thread: owns the EGL context and surface, paces frames on vsync with
 * Choreographer, and only runs while the wallpaper is visible. Public methods are called from the
 * engine (main thread) and hand work over to this thread; everything else runs on it.
 */
final class GalaxyRenderThread implements Choreographer.FrameCallback {
    private static final String TAG = "GalaxyWallpaper";
    /** A vsync can land a little early; don't drop a frame for that. */
    private static final long SLACK_NANOS = 2_000_000L;
    private static final int[] CONFIG = {
        EGL14.EGL_RED_SIZE, 8,
        EGL14.EGL_GREEN_SIZE, 8,
        EGL14.EGL_BLUE_SIZE, 8,
        EGL14.EGL_ALPHA_SIZE, 0,
        EGL14.EGL_DEPTH_SIZE, 0,
        EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
        EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT,
        EGL14.EGL_NONE
    };
    private static final int[] CONTEXT = {EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE};
    private static final int[] NO_ATTRIBS = {EGL14.EGL_NONE};

    private final HandlerThread thread = new HandlerThread("GalaxyRender", Process.THREAD_PRIORITY_DISPLAY);
    private final Handler handler;
    private final GalaxyRenderer renderer;
    private final GalaxyAnimator anim = new GalaxyAnimator();
    private final Runnable requestFrame = this::requestFrame;
    private Choreographer choreographer;

    private EGLDisplay display = EGL14.EGL_NO_DISPLAY;
    private EGLConfig config;
    private EGLContext context = EGL14.EGL_NO_CONTEXT;
    private EGLSurface surface = EGL14.EGL_NO_SURFACE;
    private boolean programReady;
    private boolean broken;

    private SurfaceHolder holder;
    private int width;
    private int height;
    private boolean visible;
    private boolean frameScheduled;
    private boolean freezeWhenSettled;
    private long frameIntervalNanos = 1_000_000_000L / Quality.MAX.fps;
    private long baseNanos;
    private long lastDrawNanos;

    GalaxyRenderThread(String fragSource) {
        renderer = new GalaxyRenderer(fragSource);
        thread.start();
        handler = new Handler(thread.getLooper());
        handler.post(() -> choreographer = Choreographer.getInstance());
    }

    // ---- From the engine ----

    void surfaceCreated(SurfaceHolder h) {
        handler.post(() -> holder = h);
    }

    void surfaceChanged(int w, int h) {
        handler.post(() -> {
            if (w != width || h != height) destroySurface();
            width = w;
            height = h;
            requestFrame();
        });
    }

    /** Blocks until GL is released: the surface must not be used after this returns. */
    void surfaceDestroyed() {
        runAndWait(() -> {
            releaseEgl();
            holder = null;
        });
    }

    /** Plays the intro toward these fractions (calories, protein, carbs, fat, water, volume, sleep). */
    void show(float[] targets) {
        float[] t = targets.clone();
        handler.post(() -> {
            visible = true;
            baseNanos = System.nanoTime();
            lastDrawNanos = 0;
            anim.intro(t, 0f);
            requestFrame();
        });
    }

    void hide() {
        handler.post(() -> {
            visible = false;
            if (frameScheduled && choreographer != null) choreographer.removeFrameCallback(this);
            frameScheduled = false;
        });
    }

    /** New numbers while showing: glide over to them. */
    void update(float[] targets) {
        float[] t = targets.clone();
        handler.post(() -> {
            anim.retarget(t, seconds(System.nanoTime()));
            requestFrame();
        });
    }

    /** Frames per second, and whether to hold still once everything has settled (Battery Saver). */
    void setPacing(int fps, boolean freeze) {
        handler.post(() -> {
            frameIntervalNanos = 1_000_000_000L / fps;
            freezeWhenSettled = freeze;
            requestFrame();
        });
    }

    /** Draw again even if frozen (the system asked for a redraw). */
    void redraw() {
        handler.post(requestFrame);
    }

    void quit() {
        handler.post(() -> {
            visible = false;
            if (choreographer != null) choreographer.removeFrameCallback(this);
            releaseEgl();
        });
        thread.quitSafely();
    }

    // ---- On the render thread ----

    private void runAndWait(Runnable r) {
        CountDownLatch done = new CountDownLatch(1);
        handler.post(() -> {
            try {
                r.run();
            } finally {
                done.countDown();
            }
        });
        try {
            if (!done.await(2, TimeUnit.SECONDS)) Log.w(TAG, "Render thread was slow to release the surface");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private float seconds(long nanos) {
        return Math.max(0f, (nanos - baseNanos) / 1e9f);
    }

    private void requestFrame() {
        if (!visible || holder == null || frameScheduled || broken || choreographer == null) return;
        frameScheduled = true;
        choreographer.postFrameCallback(this);
    }

    @Override
    public void doFrame(long frameTimeNanos) {
        frameScheduled = false;
        if (!visible || holder == null) return;
        if (lastDrawNanos != 0 && frameTimeNanos - lastDrawNanos < frameIntervalNanos - SLACK_NANOS) {
            requestFrame();
            return;
        }
        if (!ensureEgl()) {
            // Surface not ready yet, or the context was lost: try again shortly.
            if (!broken) handler.postDelayed(requestFrame, 250);
            return;
        }
        // Step the schedule by whole intervals so 24 fps on a 60 Hz panel averages 24, not 20.
        boolean behind = lastDrawNanos == 0 || frameTimeNanos - lastDrawNanos > 2 * frameIntervalNanos;
        lastDrawNanos = behind ? frameTimeNanos : lastDrawNanos + frameIntervalNanos;
        float now = seconds(frameTimeNanos);
        renderer.draw(
                width,
                height,
                anim.value(0, now),
                anim.value(1, now),
                anim.value(2, now),
                anim.value(3, now),
                anim.value(4, now),
                anim.value(5, now),
                anim.value(GalaxyAnimator.FADE, now),
                now,
                anim.value(GalaxyAnimator.SLEEP, now));
        if (!EGL14.eglSwapBuffers(display, surface)) {
            onSwapFailed(EGL14.eglGetError());
            requestFrame();
            return;
        }
        if (freezeWhenSettled && anim.settled(now)) return;
        requestFrame();
    }

    private boolean ensureEgl() {
        if (broken) return false;
        if (display == EGL14.EGL_NO_DISPLAY) {
            display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
            int[] version = new int[2];
            if (display == EGL14.EGL_NO_DISPLAY || !EGL14.eglInitialize(display, version, 0, version, 1)) {
                Log.e(TAG, "No EGL display");
                display = EGL14.EGL_NO_DISPLAY;
                broken = true;
                return false;
            }
        }
        if (config == null) {
            EGLConfig[] configs = new EGLConfig[1];
            int[] count = new int[1];
            if (!EGL14.eglChooseConfig(display, CONFIG, 0, configs, 0, 1, count, 0) || count[0] == 0) {
                Log.e(TAG, "No GLES 2 config");
                broken = true;
                return false;
            }
            config = configs[0];
        }
        boolean fresh = false;
        if (context == EGL14.EGL_NO_CONTEXT) {
            context = EGL14.eglCreateContext(display, config, EGL14.EGL_NO_CONTEXT, CONTEXT, 0);
            if (context == EGL14.EGL_NO_CONTEXT) return false;
            programReady = false;
            fresh = true;
        }
        if (surface == EGL14.EGL_NO_SURFACE) {
            if (!holder.getSurface().isValid()) return false;
            surface = EGL14.eglCreateWindowSurface(display, config, holder, NO_ATTRIBS, 0);
            if (surface == EGL14.EGL_NO_SURFACE) return false;
            fresh = true;
        }
        if (fresh && !EGL14.eglMakeCurrent(display, surface, surface, context)) {
            onSwapFailed(EGL14.eglGetError());
            return false;
        }
        if (!programReady) {
            programReady = renderer.init();
            if (!programReady) {
                broken = true;
                return false;
            }
        }
        return true;
    }

    private void onSwapFailed(int error) {
        if (error == EGL14.EGL_CONTEXT_LOST) {
            // The GPU reset or the context was taken away: start over with a new one.
            Log.w(TAG, "EGL context lost; recreating");
            renderer.forget();
            programReady = false;
            EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
            destroySurface();
            EGL14.eglDestroyContext(display, context);
            context = EGL14.EGL_NO_CONTEXT;
        } else {
            // EGL_BAD_SURFACE / EGL_BAD_NATIVE_WINDOW: the window changed under us.
            destroySurface();
        }
    }

    private void destroySurface() {
        if (surface == EGL14.EGL_NO_SURFACE) return;
        EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
        EGL14.eglDestroySurface(display, surface);
        surface = EGL14.EGL_NO_SURFACE;
    }

    private void releaseEgl() {
        if (display == EGL14.EGL_NO_DISPLAY) return;
        if (context != EGL14.EGL_NO_CONTEXT
                && surface != EGL14.EGL_NO_SURFACE
                && EGL14.eglMakeCurrent(display, surface, surface, context)) {
            renderer.release();
        } else {
            renderer.forget();
        }
        programReady = false;
        destroySurface();
        if (context != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(display, context);
        context = EGL14.EGL_NO_CONTEXT;
        EGL14.eglReleaseThread();
        EGL14.eglTerminate(display);
        display = EGL14.EGL_NO_DISPLAY;
        config = null;
    }
}
