import { describe, expect, it } from 'vitest';
import { easeOutCubic, interpolate } from './motion';

describe('interpolate', () => {
  it('starts at the old score and ends exactly on the new one', () => {
    expect(interpolate(100, 250, 0)).toBe(100);
    expect(interpolate(100, 250, 1)).toBe(250);
    expect(interpolate(100, 250, 1.5)).toBe(250);
  });
  it('counts down too, and moves fast first', () => {
    expect(interpolate(250, 100, 0.5)).toBeLessThan(175);
    expect(interpolate(250, 100, 0.5)).toBeGreaterThan(100);
    expect(interpolate(0, 100, 0.25)).toBeGreaterThan(25);
  });
  it('never overshoots', () => {
    for (let t = 0; t <= 1; t += 0.05) {
      const v = interpolate(10, 20, t);
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThanOrEqual(20);
    }
    expect(easeOutCubic(-1)).toBe(0);
  });
});
