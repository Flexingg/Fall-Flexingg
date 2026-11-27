import { BADGE_ICONS } from '@gauntlet/shared';
import { describe, expect, it } from 'vitest';
import { BADGE_PATHS } from './BadgeIcon';

describe('BadgeIcon glyphs', () => {
  it('draws every name in BADGE_ICONS', () => {
    for (const name of BADGE_ICONS) {
      expect(BADGE_PATHS[name], name).toBeDefined();
      expect(BADGE_PATHS[name].length, name).toBeGreaterThan(0);
      for (const d of BADGE_PATHS[name]) expect(d.startsWith('M'), `${name}: ${d}`).toBe(true);
    }
  });
  it('has no glyph that is not a known icon name', () => {
    expect(Object.keys(BADGE_PATHS).sort()).toEqual([...BADGE_ICONS].sort());
  });
});
