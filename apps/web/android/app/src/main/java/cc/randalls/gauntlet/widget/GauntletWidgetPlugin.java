package cc.randalls.gauntlet.widget;

import android.content.Context;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONException;

/**
 * The web app (src/lib/widget.ts) hands over today's snapshot here. It is saved for the home-screen
 * widget, the widgets are redrawn, and the same JSON is sent to a paired Wear OS watch.
 */
@CapacitorPlugin(name = "GauntletWidget")
public class GauntletWidgetPlugin extends Plugin {

    @PluginMethod
    public void publish(PluginCall call) {
        String json = call.getString("json");
        if (json == null || json.isEmpty()) {
            call.reject("json is required");
            return;
        }
        try {
            WidgetData.parse(json); // refuse something the widget couldn't draw
        } catch (JSONException e) {
            call.reject("The widget snapshot isn't valid JSON.", e);
            return;
        }
        Context ctx = getContext();
        WidgetStore.save(ctx, json);
        GauntletWidgetProvider.updateAll(ctx);
        WearSender.send(ctx, json);
        call.resolve();
    }
}
