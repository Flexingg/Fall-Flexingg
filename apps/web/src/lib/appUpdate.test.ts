import { describe, expect, it } from 'vitest';
import { compareVersions } from './appUpdate';

describe('compareVersions', () => {
  it('orders release tags against installed version names', () => {
    expect(compareVersions('v0.9.0', '0.8.0')).toBeGreaterThan(0);
    expect(compareVersions('v0.8.0', '0.8.0')).toBe(0);
    expect(compareVersions('v0.8.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('v1.0', '1.0.0')).toBe(0);
    expect(compareVersions('v1.0.1', '1.0')).toBeGreaterThan(0);
  });

  it('never treats dev builds as comparable', () => {
    expect(compareVersions('dev-abc1234', '0.8.0')).toBeNull();
    expect(compareVersions('v0.9.0', 'dev-abc1234')).toBeNull();
  });
});
