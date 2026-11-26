import { buildWidgetSnapshot } from '@gauntlet/shared';
import { useEffect } from 'react';
import { useAuth } from '../lib/auth';
import { isNative } from '../lib/platform';
import { useToday } from '../lib/queries';
import { publishWidget } from '../lib/widget';

/**
 * Android only: keeps the home-screen widget and the watch tile in step with Today (server or
 * direct mode). Renders nothing; Today's own query refreshes every minute while the app is open.
 */
export function WidgetBridge() {
  const { status } = useAuth();
  const enabled = isNative && status === 'signedIn';
  const today = useToday(enabled);
  const data = today.data;
  useEffect(() => {
    if (!enabled || !data) return;
    publishWidget(buildWidgetSnapshot(data, new Date())).catch(() => undefined);
  }, [enabled, data]);
  return null;
}
