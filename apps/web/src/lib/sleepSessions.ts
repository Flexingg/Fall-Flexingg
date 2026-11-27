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
 *
 * Stages (0.18): each night also carries `stageEvents`, the exact stage list sent to SparkyFitness
 * as `stage_events`. SparkyFitness ignores the totals in a sleep record and works everything out
 * from stored stage rows, so a record without stages leaves it with one made-up 'light' stage from
 * whenever the night was first seen (a night first uploaded 36 minutes in stayed 36 minutes long).
 * Sending the real stages every time makes each upload replace what was stored. The stages come
 * from the same sessions the totals do (copies of the same sleep are already dropped), the totals
 * are worked out from them (so what the phone says matches what SparkyFitness stores), and a session
 * with no stage data, or time the stages don't cover, counts as asleep ('light'), as before.
 */

export interface SleepStageIn {
  stage: string;
  durationMinutes: number;
  /** Health Connect gives each stage its own times; without them stages are laid end to end. */
  startDate?: string;
  endDate?: string;
}

/**
 * A stage as SparkyFitness takes it (`stage_events` on a SleepSession record). Only deep, light and
 * rem count as asleep there; awake and in_bed don't.
 */
export interface SleepStageEvent {
  stage_type: 'awake' | 'in_bed' | 'light' | 'deep' | 'rem';
  start_time: string;
  end_time: string;
  duration_in_seconds: number;
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
  /** Every stage of every session counted, oldest first: send these as `stage_events`. */
  stageEvents: SleepStageEvent[];
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
  events: SleepStageEvent[];
}

/** Health Connect stage names to SparkyFitness' (a plain "asleep" stage doesn't say how deeply). */
const STAGE_TYPE: Record<string, SleepStageEvent['stage_type']> = {
  awake: 'awake',
  inBed: 'in_bed',
  asleep: 'light',
  light: 'light',
  deep: 'deep',
  rem: 'rem',
};

const event = (
  type: SleepStageEvent['stage_type'],
  start: number,
  end: number,
): SleepStageEvent => ({
  stage_type: type,
  start_time: new Date(start).toISOString(),
  end_time: new Date(end).toISOString(),
  duration_in_seconds: Math.round((end - start) / 1000),
});

/**
 * One session's stages as non-overlapping events that cover it whole: stages are clipped to the
 * session, and any time they leave uncovered (or the whole session, when it has no stage data) is
 * 'light' sleep, which is what a session without stages has always counted as.
 */
function stageEventsOf(s: SleepSampleIn, start: number, end: number): SleepStageEvent[] {
  const wanted: { type: SleepStageEvent['stage_type']; start: number; end: number }[] = [];
  let laid = start; // for stages without times: one after another from the session start
  for (const st of s.hasStageData ? (s.stages ?? []) : []) {
    const type = STAGE_TYPE[st.stage];
    if (!type) continue;
    let a = Date.parse(st.startDate ?? '');
    let b = Date.parse(st.endDate ?? '');
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      if (!Number.isFinite(st.durationMinutes)) continue;
      a = laid;
      b = laid + st.durationMinutes * 60_000;
      laid = b;
    }
    wanted.push({ type, start: Math.max(a, start), end: Math.min(b, end) });
  }
  wanted.sort((x, y) => x.start - y.start || x.end - y.end);
  const out: SleepStageEvent[] = [];
  let cursor = start;
  for (const w of wanted) {
    const from = Math.max(w.start, cursor);
    if (w.end <= from) continue;
    if (from > cursor) out.push(event('light', cursor, from));
    out.push(event(w.type, from, w.end));
    cursor = w.end;
  }
  if (cursor < end) out.push(event('light', cursor, end));
  return out;
}

function toSession(s: SleepSampleIn): Session | null {
  const start = Date.parse(s.startDate);
  const end = Date.parse(s.endDate);
  const inBed = (end - start) / 1000;
  if (!Number.isFinite(inBed) || inBed <= 0) return null;
  const events = stageEventsOf(s, start, end);
  const seconds = (type: SleepStageEvent['stage_type']) =>
    events.filter((e) => e.stage_type === type).reduce((a, e) => a + e.duration_in_seconds, 0);
  const deep = seconds('deep');
  const light = seconds('light');
  const rem = seconds('rem');
  return {
    start,
    end,
    startIso: s.startDate,
    endIso: s.endDate,
    inBed,
    asleep: deep + light + rem,
    deep,
    light,
    rem,
    awake: seconds('awake'),
    events,
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
        stageEvents: [...s.events],
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
    n.stageEvents.push(...s.events);
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}
