package cc.randalls.gauntlet;

import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Names for the apps Health Connect says wrote the data (src/lib/appLabels.ts): Android's own label
 * for each package, so the app can show "Sleep as Android" instead of "com.urbandroid.sleep".
 * Packages Gauntlet can't see (see the <queries> in the manifest) or that aren't installed are left
 * out of the answer.
 */
@CapacitorPlugin(name = "AppLabels")
public class AppLabelsPlugin extends Plugin {

    /** { packages: string[] } to { labels: { [package]: name } }. */
    @PluginMethod
    public void labels(PluginCall call) {
        JSObject labels = new JSObject();
        JSArray packages = call.getArray("packages");
        if (packages != null) {
            PackageManager pm = getContext().getPackageManager();
            for (int i = 0; i < packages.length(); i++) {
                String name = packages.optString(i, "");
                if (name.isEmpty()) continue;
                try {
                    ApplicationInfo info = pm.getApplicationInfo(name, 0);
                    CharSequence label = pm.getApplicationLabel(info);
                    if (label != null && label.length() > 0) labels.put(name, label.toString());
                } catch (PackageManager.NameNotFoundException e) {
                    // Not installed, or not visible to us: no name.
                }
            }
        }
        JSObject out = new JSObject();
        out.put("labels", labels);
        call.resolve(out);
    }
}
