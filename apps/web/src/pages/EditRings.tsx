/**
 * Choose what the three Today rings show and each one's daily goal. Goals are typed in the person's
 * units (miles, fluid ounces, hours...) and saved in the stored unit. The same setup drives the
 * Today card, the day screen and the home-screen widget.
 */
import {
  DEFAULT_RINGS,
  defaultGoal,
  goalFromInput,
  goalPresets,
  goalToInput,
  goalUnitLabel,
  RING_HINTS,
  RING_LABELS,
  RING_METRICS,
  type RingConfig,
  type RingMetric,
} from '@gauntlet/shared';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { RING_COLORS } from '../components/Rings';
import { ErrorBox, Header, Screen, toast } from '../components/ui';
import { useDisplay } from '../lib/display';
import { useRingConfig, useSaveRings } from '../lib/ringQueries';
import type { UnitSystem } from '@gauntlet/shared';
import '../styles/rings.css';

interface Draft {
  metric: RingMetric;
  /** What is typed, in the person's units. */
  goal: string;
}

const NAMES = ['Outer ring', 'Middle ring', 'Inner ring'];

const draftOf = (c: RingConfig, units: UnitSystem): Draft[] =>
  c.map((s) => ({ metric: s.metric, goal: String(goalToInput(s.metric, s.goal, units)) }));

/** Typed text to the stored goal, or null when it is not a usable number. */
export function goalOfDraft(d: Draft, units: UnitSystem): number | null {
  const n = Number(d.goal.replace(',', '.'));
  if (!d.goal.trim() || !Number.isFinite(n) || n <= 0) return null;
  return Math.round(goalFromInput(d.metric, n, units) * 1000) / 1000;
}

export function EditRingsPage() {
  const navigate = useNavigate();
  const { units } = useDisplay();
  const q = useRingConfig();
  const save = useSaveRings();
  const [draft, setDraft] = useState<Draft[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (q.data && !draft) setDraft(draftOf(q.data, units));
  }, [q.data, draft, units]);

  const set = (i: number, patch: Partial<Draft>) =>
    setDraft((d) => d && d.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const goals = draft?.map((d) => goalOfDraft(d, units)) ?? [];
  const valid = !!draft && goals.every((g) => g != null);

  async function onSave() {
    if (!draft || !valid) return;
    setSaving(true);
    setError(null);
    try {
      await save(draft.map((d, i) => ({ metric: d.metric, goal: goals[i]! })) as RingConfig);
      toast('Rings saved');
      navigate(-1);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen tabs={false}>
      <Header title="Edit rings" back />
      <p className="muted" style={{ fontSize: 14, lineHeight: 1.45, marginBottom: 14 }}>
        Pick what each ring tracks and the daily goal that fills it. Your Today card and home-screen
        widget follow.
      </p>
      <ErrorBox error={q.error ?? error} />
      {draft && (
        <div className="stack" style={{ gap: 12 }}>
          {draft.map((d, i) => {
            const goalNum = Number(d.goal);
            return (
              <section key={i} className="card rg-slot" aria-label={NAMES[i]}>
                <h3>
                  <i style={{ background: RING_COLORS[i] }} />
                  {NAMES[i]}
                </h3>
                <label className="rg-field">
                  Stat
                  <select
                    value={d.metric}
                    aria-label={`${NAMES[i]} stat`}
                    onChange={(e) => {
                      const metric = e.target.value as RingMetric;
                      set(i, {
                        metric,
                        goal: String(goalToInput(metric, defaultGoal(metric), units)),
                      });
                    }}
                  >
                    {RING_METRICS.map((m) => (
                      <option
                        key={m}
                        value={m}
                        disabled={m !== d.metric && draft.some((x) => x.metric === m)}
                      >
                        {RING_LABELS[m]}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="rg-hint">{RING_HINTS[d.metric]}</div>
                <label className="rg-field">
                  Daily goal
                  <span className="rg-goal">
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="any"
                      value={d.goal}
                      aria-label={`${NAMES[i]} daily goal`}
                      onChange={(e) => set(i, { goal: e.target.value })}
                    />
                    <span>{goalUnitLabel(d.metric, units)}</span>
                  </span>
                </label>
                <div className="rg-presets" role="group" aria-label="Common goals">
                  {goalPresets(d.metric, units).map((p) => (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={goalNum === p}
                      onClick={() => set(i, { goal: String(p) })}
                    >
                      {p.toLocaleString('en-US')}
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
          {!valid && (
            <div className="error" role="alert">
              Every ring needs a goal bigger than zero.
            </div>
          )}
          <button className="btn" onClick={onSave} disabled={!valid || saving}>
            {saving ? 'Saving…' : 'Save rings'}
          </button>
          <button
            className="btn ghost"
            type="button"
            onClick={() => setDraft(draftOf(DEFAULT_RINGS, units))}
          >
            Reset to default
          </button>
        </div>
      )}
    </Screen>
  );
}
