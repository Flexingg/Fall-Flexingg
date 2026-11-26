import type { Recurrence } from '@gauntlet/shared';
import { Seg, Toggle } from './ui';

export interface RepeatDraft {
  every: Recurrence['every'];
  carryOver: boolean;
  /** Empty = until stopped. */
  maxRounds: string;
}

export function repeatRequest(d: RepeatDraft): {
  every: Recurrence['every'];
  carryOver: boolean;
  maxRounds: number | null;
} {
  const n = Number(d.maxRounds);
  return {
    every: d.every,
    carryOver: d.carryOver,
    maxRounds: d.maxRounds && n >= 2 ? Math.min(n, 52) : null,
  };
}

export function repeatProblem(d: RepeatDraft): string | null {
  return d.maxRounds && !(Number(d.maxRounds) >= 2) ? 'Rounds need to be 2 or more.' : null;
}

/** "Repeat" on the new-challenge screen. */
export function RepeatSetup({
  value,
  onChange,
  days,
}: {
  value: RepeatDraft | null;
  onChange: (v: RepeatDraft | null) => void;
  days: number;
}) {
  return (
    <>
      <div className="lbl">Repeat</div>
      <div className="card stack" style={{ gap: 12 }}>
        <div className="row">
          <div className="grow">
            <div style={{ fontWeight: 700 }}>Repeat this challenge</div>
            <small className="muted">
              {value
                ? `Each round runs ${days} ${days === 1 ? 'day' : 'days'}. The next one starts the day after this one ends.`
                : 'Start a new round automatically when this one ends.'}
            </small>
          </div>
          <Toggle
            checked={!!value}
            onChange={(on) =>
              onChange(on ? { every: 'week', carryOver: true, maxRounds: '' } : null)
            }
            label="Repeat this challenge"
          />
        </div>
        {value && (
          <>
            <Seg
              label="Repeat every"
              value={value.every}
              onChange={(every) => onChange({ ...value, every })}
              options={[
                { value: 'week', label: 'Every week' },
                { value: 'month', label: 'Every month' },
              ]}
            />
            <div className="row">
              <div className="grow">
                <div style={{ fontWeight: 700 }}>Invite last round’s players</div>
                <small className="muted">
                  Everyone who joined gets an invite to the next round and accepts to play.
                </small>
              </div>
              <Toggle
                checked={value.carryOver}
                onChange={(carryOver) => onChange({ ...value, carryOver })}
                label="Carry over players"
              />
            </div>
            <label className="input">
              <input
                inputMode="numeric"
                value={value.maxRounds}
                placeholder="No limit"
                onChange={(e) =>
                  onChange({ ...value, maxRounds: e.target.value.replace(/\D/g, '') })
                }
                aria-label="Number of rounds"
              />
              <span>Max rounds</span>
            </label>
          </>
        )}
      </div>
    </>
  );
}
