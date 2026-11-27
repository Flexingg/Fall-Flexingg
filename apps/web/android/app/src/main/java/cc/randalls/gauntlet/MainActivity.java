package cc.randalls.gauntlet;

import android.os.Bundle;
import cc.randalls.gauntlet.widget.GauntletWidgetPlugin;
import cc.randalls.gauntlet.notify.GauntletPushPlugin;
import cc.randalls.gauntlet.wallpaper.GalaxyWallpaperPlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-local plugins register before the bridge starts.
        registerPlugin(GalaxyWallpaperPlugin.class);
        registerPlugin(AppUpdaterPlugin.class);
        registerPlugin(AppLabelsPlugin.class);
        registerPlugin(GauntletWidgetPlugin.class);
        registerPlugin(GauntletPushPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
