package cc.randalls.gauntlet.wear;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

/** The same numbers as the tile on a plain screen; also what makes the watch app launchable. */
public class MainActivity extends Activity {

    private LinearLayout column;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER);
        column.setBackgroundColor(Color.parseColor("#0c0c0d"));
        int pad = Math.round(24 * getResources().getDisplayMetrics().density);
        column.setPadding(pad, pad, pad, pad);
        setContentView(column, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    @Override
    protected void onResume() {
        super.onResume();
        render();
        WearData.refreshFromDataLayer(this);
    }

    private void render() {
        column.removeAllViews();
        WearData data = WearData.load(this);
        if (data == null || !data.isToday()) {
            add(getString(R.string.open_on_phone), 16, "#f2f2f0", false);
            return;
        }
        add(data.stepsText(), 32, "#c6ff00", true);
        add(data.goalText() + (data.hasGoal() ? " steps" : ""), 13, "#8b8b86", false);
        if (!data.rankText.isEmpty()) {
            add(data.rankText, 16, "#f2f2f0", true);
            add(data.challengeName, 12, "#8b8b86", false);
        }
    }

    private void add(String text, float sp, String color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(sp);
        t.setTextColor(Color.parseColor(color));
        t.setGravity(Gravity.CENTER);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        column.addView(t);
    }
}
