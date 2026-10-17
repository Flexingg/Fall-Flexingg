package cc.randalls.gauntlet.wallpaper;

import android.app.WallpaperInfo;
import android.app.WallpaperManager;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Lets the Live wallpaper screen (src/pages/Wallpaper.tsx) set the wallpaper and see if it's on. */
@CapacitorPlugin(name = "GalaxyWallpaper")
public class GalaxyWallpaperPlugin extends Plugin {

    private ComponentName component() {
        return new ComponentName(getContext(), GalaxyWallpaperService.class);
    }

    /** The system preview for this wallpaper, with its "Set wallpaper" button. */
    @PluginMethod
    public void open(PluginCall call) {
        Intent preview = new Intent(WallpaperManager.ACTION_CHANGE_LIVE_WALLPAPER)
                .putExtra(WallpaperManager.EXTRA_LIVE_WALLPAPER_COMPONENT, component());
        try {
            getActivity().startActivity(preview);
            call.resolve();
            return;
        } catch (ActivityNotFoundException ignored) {
            // Some launchers only offer the full list.
        }
        try {
            getActivity().startActivity(new Intent(WallpaperManager.ACTION_LIVE_WALLPAPER_CHOOSER));
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("This phone can't set live wallpapers.", "unsupported");
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        WallpaperInfo info = WallpaperManager.getInstance(getContext()).getWallpaperInfo();
        JSObject out = new JSObject();
        out.put("active", info != null && component().equals(info.getComponent()));
        out.put("supported", getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_LIVE_WALLPAPER));
        call.resolve(out);
    }
}
