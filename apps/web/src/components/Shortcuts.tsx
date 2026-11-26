/**
 * Runs what a launcher shortcut asked for once the person is signed in: "Sync now" syncs (and
 * toasts the result, like the button), "New challenge" opens the new-challenge screen.
 */
import { App as CapApp } from '@capacitor/app';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../lib/auth';
import { useSyncNow } from '../lib/freshness';
import { isNative } from '../lib/platform';
import { parseShortcut, type ShortcutAction } from '../lib/shortcuts';

export function Shortcuts() {
  const navigate = useNavigate();
  const { status } = useAuth();
  const { sync } = useSyncNow();
  // The installed web app's "Sync now" shortcut opens /?sync=1.
  const [want, setWant] = useState<ShortcutAction | null>(() =>
    new URLSearchParams(window.location.search).get('sync') === '1' ? 'sync' : null,
  );

  useEffect(() => {
    if (!isNative) return;
    const open = (url?: string) => {
      const a = url ? parseShortcut(url) : null;
      if (a) setWant(a);
    };
    CapApp.getLaunchUrl()
      .then((l) => open(l?.url))
      .catch(() => undefined);
    const sub = CapApp.addListener('appUrlOpen', ({ url }) => open(url));
    return () => void sub.then((h) => h.remove());
  }, []);

  useEffect(() => {
    if (!want || status !== 'signedIn') return;
    setWant(null);
    if (want === 'new') navigate('/c/new');
    else {
      navigate('/', { replace: true });
      void sync();
    }
  }, [want, status, navigate, sync]);

  return null;
}
