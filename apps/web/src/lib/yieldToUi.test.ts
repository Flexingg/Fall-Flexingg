import { describe, expect, it } from 'vitest';
import { createYielder } from './yieldToUi';

describe('createYielder', () => {
  it('only yields once the work budget has been used', async () => {
    let t = 0;
    let yields = 0;
    const y = createYielder({
      budgetMs: 20,
      now: () => t,
      defer: async () => {
        yields++;
      },
    });
    t = 10;
    await y();
    expect(yields).toBe(0);
    t = 25;
    await y();
    expect(yields).toBe(1);
    t = 30; // only 5ms since the last yield
    await y();
    expect(yields).toBe(1);
  });
});
