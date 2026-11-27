/**
 * Health Connect sleep → one SparkyFitness sleep entry per night.
 *
 * SparkyFitness keeps a single sleep entry per person, day and source: a second "Health Connect"
 * session for the same day overwrites the first. So a night split in two (woke at 3am, back to
 * sleep), or a night plus an afternoon nap, used to show only whichever session was sent last.
 * Here every session that ends on the same local day is combined into one entry: times asleep and
 * stages add up, bedtime is the earliest start and wake time the latest end.
 *
 * Two apps writing the same night to Health Connect (a watch app and the phone's own tracker) would
 * double it if simply added, so sessions that mostly overlap an already-counted one are treated as
 * the same sleep and only the longer is kept.
 */

export interface SleepStageIn {
  stage: string;
  durationMinutes: number;
}

export interface SleepSampleIn {
  startDate: string;
  endDate: string;
  stages?: SleepStageIn[];
  hasStageData?: boolean;
}

export interface NightOfSleep {
  /** The local day the sleep ended on (SparkyFitness' entry_date). */
  date: string;
  bedtime: string;
  wakeTime: string;
  /** Time in bed, summed over the sessions (gaps between them don't count). */
  inBedSeconds: number;
  asleepSeconds: number;
  deepSeconds: number;
  lightSeconds: number;
  remSeconds: number;
  awakeSeconds: number;
  sessions: number;
}

/** Sessions overlapping by more than this share of the shorter one are the same sleep. */
const SAME_SLEEP_OVERLAP = 0.5;

interface Session {
  start: number;
  end: number;
  startIso: string;
  endIso: string;
  inBed: number;
  asleep: number;
  deep: number;
  light: number;
  rem: number;
  awake: number;
}

function toSession(s: SleepSampleIn): Session | null {
  const start = Date.parse(s.startDate);
  const end = Date.parse(s.endDate);
  const inBed = (end - start) / 1000;
  if (!Number.isFinite(inBed) || inBed <= 0) return null;
  const stage = (name: string) =>
    (s.stages ?? [])
      .filter((x) => x.stage === name)
      .reduce((a, x) => a + (Number.isFinite(x.durationMinutes) ? x.durationMinutes * 60 : 0), 0);
  const awake = stage('awake');
  const notAsleep = awake + stage('inBed');
  return {
    start,
    end,
    startIso: s.startDate,
    endIso: s.endDate,
    inBed,
    asleep: s.hasStageData ? Math.max(inBed - notAsleep, 0) : inBed,
    deep: stage('deep'),
    light: stage('light'),
    rem: stage('rem'),
    awake,
  };
}

const overlapShare = (a: Session, b: Session) => {
  const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  if (overlap <= 0) return 0;
  return overlap / Math.min(a.end - a.start, b.end - b.start);
};

/** Drop sessions that are another app's copy of a sleep already counted (keeping the longer). */
function withoutDuplicates(sessions: Session[]): Session[] {
  const kept: Session[] = [];
  for (const s of [...sessions].sort((a, b) => b.inBed - a.inBed || a.start - b.start)) {
    if (!kept.some((k) => overlapShare(k, s) > SAME_SLEEP_OVERLAP)) kept.push(s);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/**
 * Combine Health Connect sleep sessions into one entry per local day they ended on, oldest first.
 * `dayOf` turns an ISO timestamp into the person's local YYYY-MM-DD.
 */
export function combineSleep(
  samples: SleepSampleIn[],
  dayOf: (iso: string) => string,
): NightOfSleep[] {
  const sessions = withoutDuplicates(samples.map(toSession).filter((s): s is Session => s != null));
  const byDay = new Map<string, NightOfSleep>();
  for (const s of sessions) {
    const date = dayOf(s.endIso);
    const n = byDay.get(date);
    if (!n) {
      byDay.set(date, {
        date,
        bedtime: s.startIso,
        wakeTime: s.endIso,
        inBedSeconds: s.inBed,
        asleepSeconds: s.asleep,
        deepSeconds: s.deep,
        lightSeconds: s.light,
        remSeconds: s.rem,
        awakeSeconds: s.awake,
        sessions: 1,
      });
      continue;
    }
    // Sessions are in start order, so the first one's start is the bedtime.
    if (Date.parse(s.endIso) > Date.parse(n.wakeTime)) n.wakeTime = s.endIso;
    n.inBedSeconds += s.inBed;
    n.asleepSeconds += s.asleep;
    n.deepSeconds += s.deep;
    n.lightSeconds += s.light;
    n.remSeconds += s.rem;
    n.awakeSeconds += s.awake;
    n.sessions++;
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}
