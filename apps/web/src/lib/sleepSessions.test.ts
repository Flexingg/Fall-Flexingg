import { describe, expect, it } from 'vitest';
import { combineSleep, type SleepSampleIn } from './sleepSessions';

// UTC days keep the test independent of the machine's zone.
const dayOf = (iso: string) => iso.slice(0, 10);
const s = (start: string, end: string, extra: Partial<SleepSampleIn> = {}): SleepSampleIn => ({
  startDate: `${start}Z`,
  endDate: `${end}Z`,
  ...extra,
});
const H = 3600;

describe('combineSleep', () => {
  it('adds up a night split in two and a nap into one entry for the day', () => {
    const out = combineSleep(
      [
        s('2026-11-25T23:00:00', '2026-11-26T03:00:00'),
        s('2026-11-26T03:30:00', '2026-11-26T07:00:00'),
        s('2026-11-26T14:00:00', '2026-11-26T14:45:00'),
      ],
      dayOf,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      date: '2026-11-26',
      bedtime: '2026-11-25T23:00:00Z',
      wakeTime: '2026-11-26T14:45:00Z',
      inBedSeconds: 8.25 * H,
      asleepSeconds: 8.25 * H,
      sessions: 3,
    });
  });

  it('keeps separate days separate, oldest first', () => {
    const out = combineSleep(
      [
        s('2026-11-26T23:00:00', '2026-11-27T06:00:00'),
        s('2026-11-25T23:00:00', '2026-11-26T06:00:00'),
      ],
      dayOf,
    );
    expect(out.map((n) => [n.date, n.asleepSeconds])).toEqual([
      ['2026-11-26', 7 * H],
      ['2026-11-27', 7 * H],
    ]);
  });

  it('counts stages and leaves awake time out of time asleep', () => {
    const stages = [
      { stage: 'deep', durationMinutes: 60 },
      { stage: 'light', durationMinutes: 120 },
      { stage: 'rem', durationMinutes: 45 },
      { stage: 'awake', durationMinutes: 15 },
    ];
    const out = combineSleep(
      [
        s('2026-11-25T23:00:00', '2026-11-26T03:00:00', { stages, hasStageData: true }),
        s('2026-11-26T04:00:00', '2026-11-26T08:00:00', { stages, hasStageData: true }),
      ],
      dayOf,
    );
    expect(out[0]).toMatchObject({
      inBedSeconds: 8 * H,
      asleepSeconds: 8 * H - 30 * 60,
      deepSeconds: 2 * H,
      lightSeconds: 4 * H,
      remSeconds: 90 * 60,
      awakeSeconds: 30 * 60,
    });
  });

  it("doesn't double a night two apps both recorded, keeping the longer copy", () => {
    const out = combineSleep(
      [
        s('2026-11-25T23:10:00', '2026-11-26T06:50:00'),
        s('2026-11-25T23:00:00', '2026-11-26T07:00:00'),
        s('2026-11-26T15:00:00', '2026-11-26T15:30:00'),
      ],
      dayOf,
    );
    expect(out[0]!.sessions).toBe(2);
    expect(out[0]!.inBedSeconds).toBe(8.5 * H);
  });

  it('ignores empty or backwards sessions', () => {
    expect(
      combineSleep(
        [
          s('2026-11-26T07:00:00', '2026-11-26T07:00:00'),
          s('2026-11-26T08:00:00', '2026-11-26T07:00:00'),
        ],
        dayOf,
      ),
    ).toEqual([]);
  });

  it('keeps the stage list the totals come from', () => {
    const [n] = combineSleep(
      [
        s('2026-11-26T00:00:00', '2026-11-26T08:00:00', {
          hasStageData: true,
          stages: [
            {
              stage: 'inBed',
              durationMinutes: 30,
              startDate: '2026-11-26T00:00:00Z',
              endDate: '2026-11-26T00:30:00Z',
            },
            {
              stage: 'asleep',
              durationMinutes: 60,
              startDate: '2026-11-26T00:30:00Z',
              endDate: '2026-11-26T01:30:00Z',
            },
            {
              stage: 'deep',
              durationMinutes: 90,
              startDate: '2026-11-26T01:30:00Z',
              endDate: '2026-11-26T03:00:00Z',
            },
            {
              stage: 'awake',
              durationMinutes: 10,
              startDate: '2026-11-26T03:00:00Z',
              endDate: '2026-11-26T03:10:00Z',
            },
            // 03:10 to 05:00 is not covered by any stage: counts as light sleep.
            {
              stage: 'rem',
              durationMinutes: 60,
              startDate: '2026-11-26T05:00:00Z',
              endDate: '2026-11-26T06:00:00Z',
            },
            {
              stage: 'light',
              durationMinutes: 120,
              startDate: '2026-11-26T06:00:00Z',
              endDate: '2026-11-26T08:00:00Z',
            },
            {
              stage: 'bogus',
              durationMinutes: 5,
              startDate: '2026-11-26T01:00:00Z',
              endDate: '2026-11-26T01:05:00Z',
            },
          ],
        }),
      ],
      dayOf,
    );
    expect(
      n!.stageEvents.map((e) => [
        e.stage_type,
        e.start_time.slice(11, 16),
        e.end_time.slice(11, 16),
      ]),
    ).toEqual([
      ['in_bed', '00:00', '00:30'],
      ['light', '00:30', '01:30'],
      ['deep', '01:30', '03:00'],
      ['awake', '03:00', '03:10'],
      ['light', '03:10', '05:00'],
      ['rem', '05:00', '06:00'],
      ['light', '06:00', '08:00'],
    ]);
    // Same numbers SparkyFitness gets by adding up deep, light and rem.
    expect(n).toMatchObject({
      deepSeconds: 90 * 60,
      remSeconds: 60 * 60,
      lightSeconds: (60 + 110 + 120) * 60,
      awakeSeconds: 10 * 60,
      asleepSeconds: (90 + 60 + 290) * 60,
    });
    const asleep = n!.stageEvents
      .filter((e) => ['deep', 'light', 'rem'].includes(e.stage_type))
      .reduce((a, e) => a + e.duration_in_seconds, 0);
    expect(n!.asleepSeconds).toBe(asleep);
    expect(n!.stageEvents.every((e) => e.duration_in_seconds > 0)).toBe(true);
  });

  it('sends one light stage for a session with no stage data', () => {
    const [n] = combineSleep([s('2026-11-25T23:38:00', '2026-11-26T08:00:00')], dayOf);
    expect(n!.stageEvents).toEqual([
      {
        stage_type: 'light',
        start_time: '2026-11-25T23:38:00.000Z',
        end_time: '2026-11-26T08:00:00.000Z',
        duration_in_seconds: (8 * 60 + 22) * 60,
      },
    ]);
  });

  it('a night first seen partway and then whole covers the early stage, so the upload replaces it', () => {
    const early = combineSleep([s('2026-11-25T23:38:00', '2026-11-26T00:14:00')], dayOf)[0]!;
    const whole = combineSleep([s('2026-11-25T23:38:00', '2026-11-26T08:00:00')], dayOf)[0]!;
    // SparkyFitness deletes stored stages inside the new stages' span, except exact matches.
    const first = Date.parse(whole.stageEvents[0]!.start_time);
    const last = Date.parse(whole.stageEvents.at(-1)!.end_time);
    expect(Date.parse(early.stageEvents[0]!.start_time)).toBeGreaterThanOrEqual(first);
    expect(Date.parse(early.stageEvents[0]!.end_time)).toBeLessThanOrEqual(last);
  });

  it("sends only the kept copy's stages when two apps recorded the same sleep", () => {
    const [n] = combineSleep(
      [
        s('2026-11-25T23:10:00', '2026-11-26T06:50:00', {
          hasStageData: true,
          stages: [
            {
              stage: 'deep',
              durationMinutes: 460,
              startDate: '2026-11-25T23:10:00Z',
              endDate: '2026-11-26T06:50:00Z',
            },
          ],
        }),
        s('2026-11-25T23:00:00', '2026-11-26T07:00:00'),
      ],
      dayOf,
    );
    expect(n!.sessions).toBe(1);
    expect(n!.stageEvents).toHaveLength(1);
    expect(n!.stageEvents[0]).toMatchObject({
      stage_type: 'light',
      start_time: '2026-11-25T23:00:00.000Z',
    });
  });

  it('lays stages without times end to end and never past the session', () => {
    const [n] = combineSleep(
      [
        s('2026-11-26T00:00:00', '2026-11-26T02:00:00', {
          hasStageData: true,
          stages: [
            { stage: 'deep', durationMinutes: 60 },
            { stage: 'awake', durationMinutes: 90 },
          ],
        }),
      ],
      dayOf,
    );
    expect(n!.stageEvents.map((e) => [e.stage_type, e.duration_in_seconds])).toEqual([
      ['deep', 3600],
      ['awake', 3600],
    ]);
  });
});
