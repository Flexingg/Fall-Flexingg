/**
 * Launcher shortcuts (long-press the app icon on Android; installed web app on other systems).
 * Android sends `gauntlet-shortcut://sync` or `gauntlet-shortcut://new`; the web manifest points
 * at `/?sync=1` and `/c/new`, which the router and Shortcuts component already understand.
 */
export type ShortcutAction = 'sync' | 'new';

export function parseShortcut(url: string): ShortcutAction | null {
  const m = /^gauntlet-shortcut:\/\/(sync|new)\/?(?:[?#].*)?$/.exec(url);
  return m ? (m[1] as ShortcutAction) : null;
}
