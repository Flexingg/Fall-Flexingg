import { describe, expect, it } from 'vitest';
import {
  headline,
  historyAccessOf,
  resumePoint,
  stepLabel,
  stepPercent,
  summaryLine,
} from './historyPlan';

describe('historyAccessOf', () => {
  it('tells apart allowed, not allowed yet, too old, and unknown', () => {
    expect(historyAccessOf({ historyAccessAuthorized: true, historyAccessAvailable: true })).toBe(
      'granted',
    );
    expect(historyAccessOf({ historyAccessAuthorized: false, historyAccessAvailable: true })).toBe(
      'not_granted',
    );
    expect(historyAccessOf({ historyAccessAuthorized: false, historyAccessAvailable: false })).toBe(
      'unsupported',
    );
    expect(historyAccessOf({})).toBe('unknown');
  });
});

describe('resumePoint', () => {
  const saved = { oldestDone: '2025-03-10', target: '2021-11-27' };
  it('continues the day before the oldest day done', () => {
    expect(resumePoint(saved, '2021-11-27', '2026-11-27')).toBe('2025-03-09');
  });
  it('starts over when nothing is saved, it already reached the target, or it is nonsense', () => {
    expect(resumePoint(null, '2021-11-27', '2026-11-27')).toBeNull();
    expect(
      resumePoint({ oldestDone: '2021-11-20', target: '2021-11-27' }, '2021-11-27', '2026-11-27'),
    ).toBeNull();
    expect(
      resumePoint({ oldestDone: '2030-01-01', target: '2021-11-27' }, '2021-11-27', '2026-11-27'),
    ).toBeNull();
  });
});

describe('step wording', () => {
  it('shows a percentage while running and words otherwise', () => {
    expect(stepPercent({ doneDays: 50, totalDays: 200, state: 'running' })).toBe(25);
    expect(stepPercent({ doneDays: 0, totalDays: 0, state: 'running' })).toBe(0);
    expect(stepPercent({ doneDays: 3, totalDays: 9, state: 'done' })).toBe(100);
    expect(stepLabel({ doneDays: 50, totalDays: 200, state: 'running' })).toBe('25%');
    expect(stepLabel({ doneDays: 0, totalDays: 9, state: 'skipped' })).toBe('Not possible');
    expect(stepLabel({ doneDays: 0, totalDays: 9, state: 'failed' })).toBe('Stopped');
  });
});

describe('summaryLine', () => {
  const base = {
    oldestBefore: null,
    oldestAfter: null,
    newDays: 0,
    newRecords: 0,
    newBadges: 0,
    workouts: 0,
  };
  it('says how far the data now goes, and what it unlocked', () => {
    expect(
      summaryLine(
        { ...base, oldestAfter: '2022-09-27', newDays: 700, newRecords: 3, newBadges: 6 },
        '2026-11-27',
      ),
    ).toBe('Added 4 years 2 months of data · 3 new records · 6 badges');
    expect(
      summaryLine(
        {
          ...base,
          oldestBefore: '2026-09-27',
          oldestAfter: '2026-06-27',
          newDays: 40,
          newBadges: 1,
        },
        '2026-11-27',
      ),
    ).toBe('Added 3 months of data · 1 badge');
  });
  it('is honest when nothing came in', () => {
    expect(summaryLine(base, '2026-11-27')).toBe('No older data turned up');
    expect(summaryLine({ ...base, newDays: 1 }, '2026-11-27')).toBe('Added 1 day of data');
  });
});

describe('headline', () => {
  it('has words for every end state', () => {
    const st = {
      running: false,
      range: null,
      steps: [],
      startedAt: null,
      finishedAt: null,
      summary: null,
      error: null,
    };
    expect(headline({ ...st, state: 'done' })).toBe('Import finished');
    expect(headline({ ...st, state: 'cancelled' })).toMatch(/kept/);
    expect(headline({ ...st, state: 'running' })).toBeNull();
  });
});
