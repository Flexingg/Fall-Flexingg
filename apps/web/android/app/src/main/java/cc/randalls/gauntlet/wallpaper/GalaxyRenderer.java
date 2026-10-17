package cc.randalls.gauntlet.wallpaper;

import android.content.Context;
import android.opengl.GLES20;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.charset.StandardCharsets;

/**
 * Draws the galaxy: one fullscreen triangle with the shared fragment shader
 * (apps/web/shaders/wallpaper/galaxy.frag, packaged as an asset). Needs a current GLES 2 context;
 * used by the wallpaper's render thread. No allocations per frame.
 */
public final class GalaxyRenderer {
    static final String SHADER_ASSET = "wallpaper/galaxy.frag";
    static final String VERT = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
    private static final String TAG = "GalaxyWallpaper";

    private final String frag;
    private final FloatBuffer triangle;
    private int program;
    private int uA, uB, uRes, uS;

    public GalaxyRenderer(String fragSource) {
        frag = fragSource;
        triangle = ByteBuffer.allocateDirect(6 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
        triangle.put(new float[] {-1f, -1f, 3f, -1f, -1f, 3f}).position(0);
    }

    public static String loadShader(Context context) throws IOException {
        try (InputStream in = context.getAssets().open(SHADER_ASSET)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    /** Builds the program in the current context. False if the shader doesn't compile here. */
    public boolean init() {
        String source = frag;
        int[] range = new int[2];
        int[] precision = new int[1];
        GLES20.glGetShaderPrecisionFormat(GLES20.GL_FRAGMENT_SHADER, GLES20.GL_HIGH_FLOAT, range, 0, precision, 0);
        if (precision[0] == 0) {
            // mediump only: the noise bands, and fewer fbm octaves keep it smooth.
            Log.i(TAG, "No highp in fragment shaders; using 3 noise octaves");
            source = frag.replace("i<5;", "i<3;");
        }
        int vs = compile(GLES20.GL_VERTEX_SHADER, VERT);
        int fs = compile(GLES20.GL_FRAGMENT_SHADER, source);
        if (vs == 0 || fs == 0) return false;
        program = GLES20.glCreateProgram();
        GLES20.glAttachShader(program, vs);
        GLES20.glAttachShader(program, fs);
        GLES20.glBindAttribLocation(program, 0, "p");
        GLES20.glLinkProgram(program);
        GLES20.glDeleteShader(vs);
        GLES20.glDeleteShader(fs);
        int[] ok = new int[1];
        GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, ok, 0);
        if (ok[0] == 0) {
            Log.e(TAG, "Galaxy shader failed to link: " + GLES20.glGetProgramInfoLog(program));
            release();
            return false;
        }
        uA = GLES20.glGetUniformLocation(program, "uA");
        uB = GLES20.glGetUniformLocation(program, "uB");
        uRes = GLES20.glGetUniformLocation(program, "uRes");
        uS = GLES20.glGetUniformLocation(program, "uS");
        GLES20.glDisable(GLES20.GL_DEPTH_TEST);
        GLES20.glDisable(GLES20.GL_BLEND);
        return true;
    }

    private static int compile(int type, String src) {
        int sh = GLES20.glCreateShader(type);
        GLES20.glShaderSource(sh, src);
        GLES20.glCompileShader(sh);
        int[] ok = new int[1];
        GLES20.glGetShaderiv(sh, GLES20.GL_COMPILE_STATUS, ok, 0);
        if (ok[0] == 0) {
            Log.e(TAG, "Galaxy shader failed to compile: " + GLES20.glGetShaderInfoLog(sh));
            GLES20.glDeleteShader(sh);
            return 0;
        }
        return sh;
    }

    /** a = calories, protein, carbs, fat; b = water, volume, fade, seconds; sleep = star fraction. */
    public void draw(
            int width, int height, float a0, float a1, float a2, float a3, float b0, float b1, float b2, float b3, float sleep) {
        GLES20.glViewport(0, 0, width, height);
        GLES20.glUseProgram(program);
        GLES20.glUniform4f(uA, a0, a1, a2, a3);
        GLES20.glUniform4f(uB, b0, b1, b2, b3);
        GLES20.glUniform2f(uRes, width, height);
        GLES20.glUniform1f(uS, sleep);
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, 0);
        GLES20.glEnableVertexAttribArray(0);
        GLES20.glVertexAttribPointer(0, 2, GLES20.GL_FLOAT, false, 0, triangle);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLES, 0, 3);
    }

    /** Frees the program; call with the context still current (or after it was lost, to forget it). */
    public void release() {
        if (program != 0) GLES20.glDeleteProgram(program);
        program = 0;
    }

    /** The context went away with the program in it: nothing to delete. */
    public void forget() {
        program = 0;
    }
}
