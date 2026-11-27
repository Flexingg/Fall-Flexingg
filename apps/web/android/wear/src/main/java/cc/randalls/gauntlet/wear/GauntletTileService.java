package cc.randalls.gauntlet.wear;

import static androidx.wear.protolayout.ColorBuilders.argb;
import static androidx.wear.protolayout.DimensionBuilders.degrees;
import static androidx.wear.protolayout.DimensionBuilders.dp;
import static androidx.wear.protolayout.DimensionBuilders.expand;
import static androidx.wear.protolayout.DimensionBuilders.sp;

import android.graphics.Color;
import androidx.annotation.NonNull;
import androidx.wear.protolayout.ActionBuilders;
import androidx.wear.protolayout.LayoutElementBuilders;
import androidx.wear.protolayout.ModifiersBuilders;
import androidx.wear.protolayout.ResourceBuilders;
import androidx.wear.protolayout.TimelineBuilders;
import androidx.wear.tiles.RequestBuilders;
import androidx.wear.tiles.TileBuilders;
import androidx.wear.tiles.TileService;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;

/**
 * Today's steps against the goal as a progress arc, with the featured challenge's rank under it.
 * Draws from the snapshot DataLayerListenerService stored; asks to open Gauntlet on the phone when
 * there is none (or it is from another day).
 */
public class GauntletTileService extends TileService {

    private static final String RES_VERSION = "1";
    private static final int VOLT = Color.parseColor("#c6ff00");
    private static final int LIGHT = Color.parseColor("#f2f2f0");
    private static final int MUTED = Color.parseColor("#8b8b86");
    private static final int TRACK = Color.parseColor("#26262a");

    @NonNull
    @Override
    protected ListenableFuture<TileBuilders.Tile> onTileRequest(
            @NonNull RequestBuilders.TileRequest requestParams) {
        WearData data = WearData.load(this);
        LayoutElementBuilders.LayoutElement root =
                data == null || !data.isToday() ? emptyLayout() : stepsLayout(data);
        TileBuilders.Tile tile = new TileBuilders.Tile.Builder()
                .setResourcesVersion(RES_VERSION)
                .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(root))
                .build();
        return Futures.immediateFuture(tile);
    }

    @NonNull
    @Override
    protected ListenableFuture<ResourceBuilders.Resources> onTileResourcesRequest(
            @NonNull RequestBuilders.ResourcesRequest requestParams) {
        return Futures.immediateFuture(new ResourceBuilders.Resources.Builder().setVersion(RES_VERSION).build());
    }

    private static LayoutElementBuilders.Text text(String s, float size, int color, boolean bold) {
        return new LayoutElementBuilders.Text.Builder()
                .setText(s)
                .setFontStyle(new LayoutElementBuilders.FontStyle.Builder()
                        .setSize(sp(size))
                        .setColor(argb(color))
                        .setWeight(bold
                                ? LayoutElementBuilders.FONT_WEIGHT_BOLD
                                : LayoutElementBuilders.FONT_WEIGHT_NORMAL)
                        .build())
                .build();
    }

    /** Tapping the tile opens the small watch activity. */
    private ModifiersBuilders.Modifiers openActivity() {
        ActionBuilders.AndroidActivity activity = new ActionBuilders.AndroidActivity.Builder()
                .setPackageName(getPackageName())
                .setClassName(MainActivity.class.getName())
                .build();
        return new ModifiersBuilders.Modifiers.Builder()
                .setClickable(new ModifiersBuilders.Clickable.Builder()
                        .setId("open")
                        .setOnClick(new ActionBuilders.LaunchAction.Builder()
                                .setAndroidActivity(activity)
                                .build())
                        .build())
                .build();
    }

    private LayoutElementBuilders.LayoutElement emptyLayout() {
        return new LayoutElementBuilders.Box.Builder()
                .setWidth(expand())
                .setHeight(expand())
                .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
                .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
                .setModifiers(openActivity())
                .addContent(text(getString(R.string.open_on_phone), 14f, LIGHT, false))
                .build();
    }

    private LayoutElementBuilders.LayoutElement stepsLayout(WearData data) {
        // The arc starts at 12 o'clock: the part done, then the part still to go.
        float done = Math.min(data.fraction(), 0.995f) * 360f;
        LayoutElementBuilders.Arc.Builder arc = new LayoutElementBuilders.Arc.Builder()
                .setAnchorAngle(degrees(0f))
                .setAnchorType(LayoutElementBuilders.ARC_ANCHOR_START);
        if (done > 1f) arc.addContent(arcLine(done, VOLT));
        arc.addContent(arcLine(360f - done, TRACK));

        LayoutElementBuilders.Column.Builder column = new LayoutElementBuilders.Column.Builder()
                .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
                .addContent(text(data.stepsText(), 28f, VOLT, true))
                .addContent(text(data.goalText(), 12f, MUTED, false));
        if (!data.rankText.isEmpty()) {
            column.addContent(text(data.rankText, 14f, LIGHT, true));
        }

        return new LayoutElementBuilders.Box.Builder()
                .setWidth(expand())
                .setHeight(expand())
                .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
                .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
                .setModifiers(openActivity())
                .addContent(arc.build())
                .addContent(column.build())
                .build();
    }

    private static LayoutElementBuilders.ArcLine arcLine(float lengthDegrees, int color) {
        return new LayoutElementBuilders.ArcLine.Builder()
                .setLength(degrees(lengthDegrees))
                .setThickness(dp(8f))
                .setColor(argb(color))
                .build();
    }
}
