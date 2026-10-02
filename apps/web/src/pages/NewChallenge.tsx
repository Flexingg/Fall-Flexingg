import {
  addDays,
  BUILTIN_METRICS,
  daysBetween,
  isDateString,
  METRIC_GROUPS,
  metricDef,
  METRICS,
  SCORING_LABELS,
  scoringLabel,
  type MetricGroup,
  type WeightGoalParams,
  todayIn,
  validateRules,
  weekday,
  type ChallengeDetail,
  type CreateChallengeRequest,
  type MetricKey,
  type ScoringMode,
} from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Icon } from '../components/Icon';
import { Avatar, ErrorBox, Header, Screen, Seg, Toggle, NoSourcesNote } from '../components/ui';
import { post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateRange } from '../lib/format';
import { timezone } from '../lib/platform';
import { useCustomMetrics, useFriends, useLifts, useToday } from '../lib/queries';
import { WeightGoalFields } from '../components/WeightGoal';

type Duration = '3' | 'weekend' | '7' | '30' | 'custom';
const CUSTOM = 'custom' as const;
/** One exercise: the heaviest set, or estimated 1RM gain. */
const LIFT = 'lift' as const;
type Choice = MetricKey | typeof CUSTOM | typeof LIFT;

function groupOf(choice: Choice): MetricGroup {
  if (choice === CUSTOM) return 'custom';
  if (choice === LIFT) return 'strength';
  return metricDef(choice as MetricKey).group;
}

function window(
  duration: Duration,
  today: string,
  custom: { start: string; end: string },
): { start: string; end: string } {
  if (duration === 'custom') return custom;
  if (duration === 'weekend') {
    const dow = weekday(today); // 0 Sun .. 6 Sat
    if (dow === 6) return { start: today, end: addDays(today, 1) };
    if (dow === 0) return { start: today, end: today };
    const sat = addDays(today, 6 - dow);
    return { start: sat, end: addDays(sat, 1) };
  }
  const n = Number(duration);
  return { start: today, end: addDays(today, n - 1) };
}

const DEFAULT_GOALS: Partial<Record<MetricKey, number>> = {
  steps: 100_000,
  distance: 100,
  active_minutes: 300,
  active_calories: 5000,
  workouts: 5,
  sleep: 8,
  resting_hr: 55,
  lift_volume: 50_000,
  lift_sets: 100,
  water: 20,
  fast_hours: 100,
  fasts_completed: 5,
  weight_goal: 100,
  calorie_adherence: 500,
  macro_adherence: 500,
  water_goal: 500,
};

const DAILY_TARGETS: Partial<Record<MetricKey, number>> = {
  steps: 10_000,
  distance: 5,
  active_minutes: 30,
  active_calories: 500,
  workouts: 1,
  sleep: 7,
  resting_hr: 60,
  lift_sets: 12,
  calorie_adherence: 80,
  macro_adherence: 80,
  water_goal: 100,
  water: 2,
  protein: 150,
  fast_hours: 16,
  fasts_completed: 1,
};

export function NewChallengePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const friends = useFriends();
  const todayQ = useToday();
  const [name, setName] = useState('');
  const [metric, setMetric] = useState<Choice>('distance');
  const [lift, setLift] = useState('');
  const [liftKind, setLiftKind] = useState<'lift_max:' | 'lift_e1rm:'>('lift_max:');
  const [weightGoal, setWeightGoal] = useState<WeightGoalParams | null>(null);
  const [customId, setCustomId] = useState('');
  const [customAgg, setCustomAgg] = useState<'sum' | 'avg'>('sum');
  const [customLower, setCustomLower] = useState(false);
  const [scoring, setScoring] = useState<ScoringMode>('total');
  const [goal, setGoal] = useState('');
  const [duration, setDuration] = useState<Duration>('7');
  const [invited, setInvited] = useState<Set<string>>(new Set());
  const [isPublic, setIsPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const customMetrics = useCustomMetrics(metric === CUSTOM);
  const lifts = useLifts(metric === LIFT);

  const today = todayIn(timezone);
  const [customStart, setCustomStart] = useState(today);
  const [customEnd, setCustomEnd] = useState(addDays(today, 6));
  const [showEvents, setShowEvents] = useState(false);
  const { start, end } = window(duration, today, { start: customStart, end: customEnd });
  const datesProblem =
    duration !== 'custom'
      ? null
      : !isDateString(customStart) || !isDateString(customEnd)
        ? 'Pick a start and an end date.'
        : customEnd < customStart
          ? 'The end date is before the start date.'
          : customEnd < today
            ? 'That challenge would already be over.'
            : daysBetween(customStart, customEnd) + 1 > 366
              ? 'Challenges can last at most a year.'
              : null;
  const timing =
    duration === 'custom' && !datesProblem
      ? `${daysBetween(start, end) + 1} days · ${
          start > today
            ? `starts in ${daysBetween(today, start)} ${daysBetween(today, start) === 1 ? 'day' : 'days'}`
            : start === today
              ? 'starts today'
              : `started ${daysBetween(start, today)} ${daysBetween(start, today) === 1 ? 'day' : 'days'} ago, past data counts`
        }`
      : null;
  const isCustom = metric === CUSTOM;
  const isLift = metric === LIFT;
  const metricKey: MetricKey | null = isCustom
    ? null
    : isLift
      ? lift
        ? (`${liftKind}${lift}` as MetricKey)
        : null
      : (metric as MetricKey);
  const def = metricKey
    ? metricDef(metricKey)
    : isLift
      ? metricDef(`${liftKind}x` as MetricKey)
      : null;
  const aggregate = isCustom ? customAgg : (def?.aggregate ?? 'sum');
  const needsTarget = def?.transform === 'weight_goal';
  const customChoice = customMetrics.data?.find((m) => m.categoryId === customId);
  const unit = isCustom ? (customChoice?.unit ?? '') : (def?.unit ?? '');
  const suggested =
    scoring === 'streak'
      ? DAILY_TARGETS[metric as MetricKey]
      : scoring === 'race_to_goal'
        ? DEFAULT_GOALS[metric as MetricKey]
        : undefined;
  const goalNum = goal.trim() ? Number(goal) : (suggested ?? null);
  const ruleProblem = validateRules({ scoring, aggregate, goal: goalNum });
  const scoringOptions = useMemo(
    () =>
      (def?.scoring ?? (Object.keys(SCORING_LABELS) as ScoringMode[])).filter(
        (s) => aggregate !== 'avg' || s !== 'race_to_goal',
      ),
    [def, aggregate],
  );
  const scoringOk = scoringOptions.includes(scoring);
  const liftLabel = lifts.data?.find((l) => l.key === lift)?.label;
  const placeholderName = isCustom
    ? (customChoice?.label ?? 'Custom')
    : isLift
      ? `${liftLabel ?? 'Lift'} ${liftKind === 'lift_max:' ? 'Max' : '1RM Gain'}`
      : `${def?.label} ${duration === 'weekend' ? 'Weekend' : duration === 'custom' ? 'Challenge' : `${duration}-Day`}`;

  function choose(next: Choice) {
    setMetric(next);
    const d =
      next === CUSTOM
        ? null
        : next === LIFT
          ? metricDef(`${liftKind}x` as MetricKey)
          : metricDef(next as MetricKey);
    // Keep the way to win if it still makes sense, otherwise the metric's default.
    if (d && !d.scoring.includes(scoring)) setScoring(d.scoring[0]!);
    setGoal('');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: CreateChallengeRequest = {
        name: name.trim() || placeholderName,
        metric: isCustom
          ? (`custom:${customChoice?.label.toLowerCase() ?? 'x'}` as MetricKey)
          : metricKey!,
        custom:
          isCustom && customChoice
            ? {
                categoryId: customChoice.categoryId,
                label: customChoice.label,
                unit: customChoice.unit ?? undefined,
                aggregate: customAgg,
                lowerIsBetter: customLower,
              }
            : undefined,
        scoring,
        goal: goalNum,
        startDate: start,
        endDate: end,
        timezone,
        inviteUserIds: [...invited],
        visibility: isPublic ? 'public' : 'private',
        showEvents,
        params: needsTarget && weightGoal ? { weightGoal } : undefined,
      };
      const created = await post<ChallengeDetail>('/api/challenges', body);
      await qc.invalidateQueries();
      navigate(`/c/${created.id}`, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const tilesFor = (group: MetricGroup) => [
    ...BUILTIN_METRICS.filter((k) => METRICS[k].group === group).map((k) => ({
      key: k as Choice,
      label: METRICS[k].label,
      icon: METRICS[k].icon,
    })),
    ...(group === 'strength'
      ? [{ key: LIFT as Choice, label: 'One exercise', icon: 'dumbbell' as const }]
      : []),
    ...(group === 'custom'
      ? [{ key: CUSTOM as Choice, label: 'Custom', icon: 'plus' as const }]
      : []),
  ];

  const details = () => (
    <>
      {def?.hint && !isCustom && (
        <p className="muted" style={{ fontSize: 12, lineHeight: 1.45, marginTop: 10 }}>
          {def.hint}
        </p>
      )}

      {isLift && (
        <div className="stack" style={{ marginTop: 10 }}>
          <label className="input">
            <select
              value={lift}
              onChange={(e) => setLift(e.target.value)}
              aria-label="Exercise"
              required
            >
              <option value="">
                {lifts.isPending ? 'Loading your exercises…' : 'Choose an exercise'}
              </option>
              {lifts.data?.map((l) => (
                <option key={l.key} value={l.key}>
                  {l.label} · {l.sessions} {l.sessions === 1 ? 'session' : 'sessions'}
                </option>
              ))}
            </select>
          </label>
          {lifts.data?.length === 0 && (
            <div className="notice">
              No weighted sets found yet. Connect Liftosaur or Hevy on Data sources, or log sets in
              SparkyFitness.
            </div>
          )}
          <Seg
            label="Score on"
            value={liftKind}
            onChange={(v) => {
              setLiftKind(v);
              const d = metricDef(`${v}x` as MetricKey);
              if (!d.scoring.includes(scoring)) setScoring(d.scoring[0]!);
            }}
            options={[
              { value: 'lift_max:', label: 'Heaviest set' },
              { value: 'lift_e1rm:', label: '1RM gain %' },
            ]}
          />
        </div>
      )}

      {needsTarget && (
        <>
          <div className="lbl">Your target</div>
          <WeightGoalFields value={weightGoal} onChange={setWeightGoal} />
        </>
      )}

      {isCustom && (
        <div className="stack" style={{ marginTop: 10 }}>
          <label className="input">
            <select
              value={customId}
              onChange={(e) => setCustomId(e.target.value)}
              aria-label="Custom metric"
              required
            >
              <option value="">
                {customMetrics.isPending
                  ? 'Loading your SparkyFitness metrics…'
                  : 'Choose a SparkyFitness metric'}
              </option>
              {customMetrics.data?.map((m) => (
                <option key={m.categoryId} value={m.categoryId}>
                  {m.label}
                  {m.unit ? ` (${m.unit})` : ''}
                </option>
              ))}
            </select>
          </label>
          {customMetrics.data?.length === 0 && (
            <div className="notice">
              No custom measurements found. Create one in SparkyFitness under Check-in → Custom
              measurements.
            </div>
          )}
          <Seg
            label="Combine days by"
            value={customAgg}
            onChange={setCustomAgg}
            options={[
              { value: 'sum', label: 'Add up days' },
              { value: 'avg', label: 'Average days' },
            ]}
          />
          <div className="row card" style={{ padding: '10px 14px' }}>
            <span className="grow" style={{ fontSize: 14, fontWeight: 600 }}>
              Lower is better
            </span>
            <Toggle checked={customLower} onChange={setCustomLower} label="Lower is better" />
          </div>
        </div>
      )}
    </>
  );

  return (
    <Screen>
      <Header title="New challenge" back="/challenges" />
      <form onSubmit={submit}>
        {todayQ.data && !todayQ.data.hasSources && <NoSourcesNote />}
        <label className="input">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={placeholderName}
            maxLength={60}
            aria-label="Challenge name"
          />
          <span>Name</span>
        </label>

        {METRIC_GROUPS.map((g) => (
          <div key={g.key}>
            <div className="lbl">{g.label}</div>
            <div className="metric-grid" role="group" aria-label={g.label}>
              {tilesFor(g.key).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  aria-pressed={metric === t.key}
                  onClick={() => choose(t.key)}
                >
                  <Icon name={t.icon} size={22} />
                  {t.label}
                </button>
              ))}
            </div>
            {groupOf(metric) === g.key && details()}
          </div>
        ))}
        <div className="lbl">How to win</div>
        <label className="input">
          <select
            value={scoring}
            onChange={(e) => setScoring(e.target.value as ScoringMode)}
            aria-label="How to win"
          >
            {scoringOptions.map((s) => (
              <option key={s} value={s}>
                {scoringLabel(s, aggregate)}
              </option>
            ))}
          </select>
        </label>

        <div className="lbl">{scoring === 'streak' ? 'Daily target' : 'Goal'}</div>
        <label className="input">
          <input
            inputMode="decimal"
            value={goal}
            onChange={(e) => setGoal(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder={suggested != null ? String(suggested) : 'None'}
            aria-label="Goal"
          />
          <span>
            {unit}
            {scoring === 'race_to_goal'
              ? ' · first to reach it wins'
              : scoring === 'streak'
                ? ' per day'
                : scoring === 'total'
                  ? ' · optional'
                  : ''}
          </span>
        </label>

        <div className="lbl">
          <span>Duration</span>
          <span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>
            {dateRange(start, end)}
          </span>
        </div>
        <Seg
          label="Duration"
          value={duration}
          onChange={setDuration}
          options={[
            { value: '3', label: '3 days' },
            { value: 'weekend', label: 'Weekend' },
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' },
            { value: 'custom', label: 'Custom' },
          ]}
        />
        {duration === 'custom' && (
          <div className="stack" style={{ marginTop: 10, gap: 10 }}>
            <div className="row" style={{ gap: 10 }}>
              <label className="input grow">
                <input
                  type="date"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                  aria-label="Start date"
                />
                <span>Start</span>
              </label>
              <label className="input grow">
                <input
                  type="date"
                  value={customEnd}
                  min={customStart}
                  onChange={(e) => setCustomEnd(e.target.value)}
                  aria-label="End date"
                />
                <span>End</span>
              </label>
            </div>
            <small className="muted" style={{ lineHeight: 1.45 }}>
              {timing ?? datesProblem} Start in the past to count activity that already happened
              (people without data back then start behind). Dates are fixed once the challenge is
              created.
            </small>
          </div>
        )}

        <div className="lbl">Invite</div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          {user && <Avatar user={user} size={42} me />}
          {friends.data?.friends.map((f) => {
            const on = invited.has(f.id);
            return (
              <button
                type="button"
                key={f.id}
                aria-pressed={on}
                aria-label={`Invite ${f.displayName}`}
                onClick={() =>
                  setInvited((s) => {
                    const n = new Set(s);
                    if (on) n.delete(f.id);
                    else n.add(f.id);
                    return n;
                  })
                }
                style={{
                  borderRadius: '50%',
                  outline: on ? '2px solid var(--volt)' : 'none',
                  outlineOffset: 2,
                  color: on ? 'var(--volt)' : undefined,
                }}
              >
                <Avatar user={f} size={42} />
              </button>
            );
          })}
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          {friends.data?.friends.length ? 'Tap friends to invite them. ' : ''}You can share a link
          to the challenge once it's created.
        </p>

        <div className="lbl">Show events</div>
        <div className="card stack" style={{ gap: 6 }}>
          <div className="row">
            <div className="grow">
              <div style={{ fontWeight: 700 }}>Show what counted</div>
              <small className="muted">
                {showEvents
                  ? 'Participants can open the workouts, sets and fasts behind each score. People can switch this off for themselves in Privacy.'
                  : 'Only totals are shown.'}
              </small>
            </div>
            <Toggle checked={showEvents} onChange={setShowEvents} label="Show events" />
          </div>
        </div>

        <div className="lbl">Who can join</div>
        <div className="card stack" style={{ gap: 8 }}>
          <div className="row">
            <div className="grow">
              <div style={{ fontWeight: 700 }}>Public</div>
              <small className="muted">
                {isPublic
                  ? 'Listed in Discover. Anyone with a public profile can join.'
                  : 'Invite only: friends you pick and people with the link.'}
              </small>
            </div>
            <Toggle
              checked={isPublic}
              onChange={setIsPublic}
              label="Public challenge"
              disabled={user?.visibility !== 'public'}
            />
          </div>
          {user?.visibility !== 'public' && (
            <small className="muted">
              Make your profile public (Profile → Public profile) to start public challenges.
            </small>
          )}
        </div>

        <div className="dock stack">
          <ErrorBox error={error ?? (ruleProblem ? new Error(ruleProblem) : null)} />
          <button
            className="btn"
            disabled={
              busy ||
              !!ruleProblem ||
              !!datesProblem ||
              !scoringOk ||
              (isCustom && !customChoice) ||
              (isLift && !lift) ||
              (needsTarget && !weightGoal)
            }
          >
            {busy ? <span className="spinner" /> : 'Start challenge'}
          </button>
        </div>
      </form>
    </Screen>
  );
}
