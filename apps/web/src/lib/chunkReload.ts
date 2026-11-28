/**
 * Screens load as separate files. After an update the old files are gone, so an open (or
 * service-worker-cached) page can ask for a file that no longer exists. The cure is a reload to get
 * the new page, but only once in a while: a real outage must not turn into a reload loop.
 */
const KEY = 'gauntlet.chunk-reload';
/** A second failure within this long is a real problem, not a stale page. */
export const RELOAD_COOLDOWN_MS = 30_000;

/** Pure rule: reload unless we already did a moment ago. */
export function shouldReload(now: number, lastReloadAt: number | null): boolean {
  return lastReloadAt == null || now - lastReloadAt > RELOAD_COOLDOWN_MS;
}

function read(): number | null {
  try {
    const v = Number(sessionStorage.getItem(KEY));
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Reload once for a file that failed to load. Returns false when we reloaded too recently. */
export function reloadForStaleChunk(now = Date.now()): boolean {
  if (!shouldReload(now, read())) return false;
  try {
    sessionStorage.setItem(KEY, String(now));
  } catch {
    /* storage blocked: reload anyway, once per page life is all we can promise */
  }
  window.location.reload();
  return true;
}
