package cc.randalls.gauntlet.wear;

import com.google.android.gms.wearable.DataEvent;
import com.google.android.gms.wearable.DataEventBuffer;
import com.google.android.gms.wearable.DataMapItem;
import com.google.android.gms.wearable.WearableListenerService;

/** Woken when the phone app publishes: keeps the snapshot and asks for a fresh tile. */
public class DataLayerListenerService extends WearableListenerService {

    @Override
    public void onDataChanged(DataEventBuffer dataEvents) {
        for (DataEvent event : dataEvents) {
            if (event.getType() != DataEvent.TYPE_CHANGED) continue;
            if (!WearData.PATH.equals(event.getDataItem().getUri().getPath())) continue;
            String json = DataMapItem.fromDataItem(event.getDataItem()).getDataMap().getString("json");
            if (json != null) WearData.save(this, json);
        }
    }
}
