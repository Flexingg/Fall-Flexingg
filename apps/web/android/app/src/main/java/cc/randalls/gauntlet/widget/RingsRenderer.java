package cc.randalls.gauntlet.widget;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;

/** Draws the three Today rings (same geometry and colours as src/components/Rings.tsx). */
final class RingsRenderer {
    static final int VOLT = Color.parseColor("#c6ff00");
    static final int LIGHT = Color.parseColor("#f2f2f0");
    static final int MUTED = Color.parseColor("#8b8b86");
    private static final int TRACK = Color.parseColor("#26262a");

    private RingsRenderer() {}

    /** fractions: steps, active calories, active minutes (0..1). */
    static Bitmap draw(int sizePx, float[] fractions) {
        Bitmap bmp = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bmp);
        float scale = sizePx / 110f;
        float[] radii = {48f, 34f, 20f};
        int[] colors = {VOLT, LIGHT, MUTED};

        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(10f * scale);
        paint.setStrokeCap(Paint.Cap.ROUND);

        float c = 55f * scale;
        for (int i = 0; i < radii.length; i++) {
            float r = radii[i] * scale;
            RectF oval = new RectF(c - r, c - r, c + r, c + r);
            paint.setColor(TRACK);
            canvas.drawArc(oval, 0f, 360f, false, paint);
            float p = i < fractions.length ? Math.max(0f, Math.min(1f, fractions[i])) : 0f;
            if (p > 0f) {
                paint.setColor(colors[i]);
                canvas.drawArc(oval, -90f, 360f * p, false, paint);
            }
        }
        return bmp;
    }
}
