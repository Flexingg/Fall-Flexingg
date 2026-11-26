/**
 * Hands the Android home-screen widget and the Wear OS tile their numbers. Native code keeps the
 * latest snapshot and redraws; nothing happens off Android.
 */
import { registerPlugin } from '@capacitor/core';
import type { WidgetSnapshot } from '@gauntlet/shared';
import { isNative } from './platform';

interface GauntletWidgetPlugin {
  /** Stores the JSON, redraws every widget and sends it to a paired watch. */
  publish(options: { json: string }): Promise<void>;
}

const GauntletWidget = registerPlugin<GauntletWidgetPlugin>('GauntletWidget');

let published: string | null = null;
let publishedAt = 0;
/** Even unchanged numbers are re-sent this often so the widget's "Updated" time stays honest. */
const REFRESH_MS = 20 * 60_000;

/** Skips the write when the numbers haven't changed recently (updatedAt aside). */
export async function publishWidget(snapshot: WidgetSnapshot): Promise<void> {
  if (!isNative) return;
  const { updatedAt: _ignored, ...rest } = snapshot;
  const key = JSON.stringify(rest);
  if (key === published && Date.now() - publishedAt < REFRESH_MS) return;
  await GauntletWidget.publish({ json: JSON.stringify(snapshot) });
  published = key;
  publishedAt = Date.now();
}
