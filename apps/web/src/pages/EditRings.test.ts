import { describe, expect, it } from 'vitest';
import { goalOfDraft } from './EditRings';

describe('goalOfDraft', () => {
  it('reads what is typed in the persons units back to the stored unit', () => {
    expect(goalOfDraft({ metric: 'distance', goal: '5' }, 'imperial')).toBe(8.047);
    expect(goalOfDraft({ metric: 'distance', goal: '5' }, 'metric')).toBe(5);
    expect(goalOfDraft({ metric: 'water', goal: '64' }, 'imperial')).toBe(1.893);
    expect(goalOfDraft({ metric: 'sleep', goal: '7,5' }, 'imperial')).toBe(7.5);
  });
  it('rejects blanks, zero, negatives and words', () => {
    for (const goal of ['', ' ', '0', '-3', 'abc'])
      expect(goalOfDraft({ metric: 'steps', goal }, 'metric'), goal).toBeNull();
  });
});
