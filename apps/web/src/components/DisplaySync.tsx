import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useAuth } from '../lib/auth';
import { getDisplay, useDisplay } from '../lib/display';
import { updateSettings } from '../lib/session';

/**
 * Keeps the display settings (units, clock, number format) in step with the account: the first
 * time someone signs in with nothing chosen, their device's defaults are saved so the server words
 * notifications the same way; and when the settings change, data some screens worded on the
 * server (Trends highlights, workout summaries) is fetched again.
 */
export function DisplaySync() {
  const { user, mode, setUser } = useAuth();
  const display = useDisplay();
  const qc = useQueryClient();
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    qc.invalidateQueries();
  }, [display, qc]);

  const unset = !!user && mode === 'server' && !user.demo && user.settings.units == null;
  useEffect(() => {
    if (!unset) return;
    // What is in effect now: this browser's choice if it has one, else the device's own defaults.
    const d = getDisplay();
    updateSettings({ units: d.units, clock: d.clock, locale: d.locale })
      .then(setUser)
      .catch(() => undefined);
    // Only when the account has no choice saved yet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unset]);
  return null;
}
