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
});
