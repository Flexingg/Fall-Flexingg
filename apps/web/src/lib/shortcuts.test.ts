import { describe, expect, it } from 'vitest';
import { parseShortcut } from './shortcuts';

describe('parseShortcut', () => {
  it('knows the two launcher shortcuts', () => {
    expect(parseShortcut('gauntlet-shortcut://sync')).toBe('sync');
    expect(parseShortcut('gauntlet-shortcut://new')).toBe('new');
  });
  it('ignores everything else', () => {
    expect(parseShortcut('https://gauntlet.randalls.cc/j/abc')).toBeNull();
    expect(parseShortcut('gauntlet-shortcut://other')).toBeNull();
    expect(parseShortcut('gauntlet-widget://open/c/1')).toBeNull();
  });
});
