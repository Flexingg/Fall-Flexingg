import {
  addDays,
  BUILTIN_METRICS,
  BASELINE_CHOICES,
  daysBetween,
  isDateString,
  SOLO_KINDS,
  SOLO_LABELS,
  soloScoring,
  type SoloKind,
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
import { StakeField } from '../components/Stake';
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
import { teamsProblem, teamsRequest, TeamsSetup, type TeamsDraft } from '../components/TeamsSetup';
import {
  repeatProblem,
  repeatRequest,
  RepeatSetup,
  type RepeatDraft,
} from '../components/RepeatSetup';

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
  const [mode, setMode] = useState<'versus' | 'solo'>('versus');
  const [soloKind, setSoloKind] = useState<SoloKind>('target');
  const [streakDays, setStreakDays] = useState('7');
  const [improvePct, setImprovePct] = useState('10');
  const [direction, setDirection] = useState<'up' | 'down' | null>(null);
  const [baselineDays, setBaselineDays] = useState<number>(30);
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
  const [stake, setStake] = useState('');
  const [teams, setTeams] = useState<TeamsDraft | null>(null);
  const [repeat, setRepeat] = useState<RepeatDraft | null>(null);
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
  const solo = mode === 'solo';
  // Which kinds of solo challenge suit the chosen stat: running figures (weight, 1RM gain) can only
  // aim at their own target, and totals only make sense for stats that add up.
  const kindOk = (k: SoloKind) =>
    def?.transform ? k === 'target' : k === 'target' ? aggregate !== 'avg' : true;
  const kind: SoloKind = kindOk(soloKind) ? soloKind : (SOLO_KINDS.find(kindOk) ?? 'average');
  const dir: 'up' | 'down' = direction ?? (def?.lowerIsBetter ? 'down' : 'up');
  const effScoring: ScoringMode = solo
    ? soloScoring(kind, { heaviest: isLift && liftKind === 'lift_max:' })
    : scoring;
  const suggested =
    effScoring === 'streak' || (solo && kind === 'average')
      ? DAILY_TARGETS[metric as MetricKey]
      : effScoring === 'race_to_goal'
        ? DEFAULT_GOALS[metric as MetricKey]
        : undefined;
  const goalNum = solo && needsTarget ? 100 : goal.trim() ? Number(goal) : (suggested ?? null);
  const ruleProblem = solo
    ? kind === 'improve'
      ? null
      : validateRules({ scoring: effScoring, aggregate, goal: goalNum })
    : validateRules({ scoring, aggregate, goal: goalNum });
  const soloProblem = !solo
    ? null
    : kind === 'improve'
      ? Number(improvePct) > 0
        ? null
        : 'Enter how much better you want to be.'
      : kind === 'streak' && !(Number(streakDays) >= 2)
        ? 'A streak needs at least 2 days.'
        : !needsTarget && !(goalNum && goalNum > 0)
          ? 'Set the number to aim for.'
          : null;
  const extraProblem = solo
    ? null
    : ((teams ? teamsProblem(teams) : null) ?? (repeat ? repeatProblem(repeat) : null));
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
        scoring: effScoring,
        goal: solo && kind === 'improve' ? null : goalNum,
        solo: solo
          ? kind === 'streak'
            ? { kind, days: Number(streakDays) }
            : kind === 'improve'
              ? { kind, changePct: Number(improvePct), direction: dir, baselineDays }
              : { kind }
          : undefined,
        startDate: start,
        endDate: end,
        timezone,
        inviteUserIds: solo ? [] : [...invited],
        visibility: isPublic && !solo ? 'public' : 'private',
        showEvents,
        stake: !solo && stake.trim() ? stake.trim() : undefined,
        teams: !solo && teams ? teamsRequest(teams) : undefined,
        recurrence: !solo && repeat ? repeatRequest(repeat) : undefined,
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
        <Seg
          label="Who is it against"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'versus', label: 'Versus friends' },
            { value: 'solo', label: 'Solo' },
          ]}
        />
        <div style={{ height: 12 }} />
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
        {solo ? (
          <>
            <div className="lbl">Your goal</div>
            <div
              className="metric-grid"
              role="group"
              aria-label="Goal type"
              style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}
            >
              {SOLO_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={kind === k}
                  disabled={!kindOk(k)}
                  onClick={() => setSoloKind(k)}
                  style={{ padding: '12px 8px', opacity: kindOk(k) ? 1 : 0.4 }}
                >
                  {SOLO_LABELS[k].title}
                </button>
              ))}
            </div>
            <p className="muted" style={{ fontSize: 12, lineHeight: 1.45, marginTop: 8 }}>
              {SOLO_LABELS[kind].blurb}
              {def?.transform ? ' This stat is already measured against your own target.' : ''}
            </p>

            {kind === 'improve' ? (
              <div className="stack" style={{ marginTop: 10, gap: 10 }}>
                <Seg
                  label="Direction"
                  value={dir}
                  onChange={setDirection}
                  options={[
                    { value: 'up', label: 'Increase' },
                    { value: 'down', label: 'Decrease' },
                  ]}
                />
                <label className="input">
                  <input
                    inputMode="decimal"
                    value={improvePct}
                    onChange={(e) => setImprovePct(e.target.value.replace(/[^\d.]/g, ''))}
                    aria-label="Percent change"
                  />
                  <span>% {dir === 'up' ? 'better' : 'lower'} than before</span>
                </label>
                <label className="input">
                  <select
                    value={baselineDays}
                    onChange={(e) => setBaselineDays(Number(e.target.value))}
                    aria-label="Compared with"
                  >
                    {BASELINE_CHOICES.map((n) => (
                      <option key={n} value={n}>
                        vs my previous {n} days
                      </option>
                    ))}
                  </select>
                </label>
                <small className="muted" style={{ lineHeight: 1.45 }}>
                  Compared with your{' '}
                  {isLift && liftKind === 'lift_max:' ? 'best day' : 'daily average'} over the{' '}
                  {baselineDays} days before the start. If there was no data then, there is nothing
                  to compare with.
                </small>
              </div>
            ) : needsTarget ? (
              <small
                className="muted"
                style={{ display: 'block', marginTop: 10, lineHeight: 1.45 }}
              >
                The goal is 100% of your own target below.
              </small>
            ) : (
              <div className="stack" style={{ marginTop: 10, gap: 10 }}>
                <label className="input">
                  <input
                    inputMode="decimal"
                    value={goal}
                    onChange={(e) => setGoal(e.target.value.replace(/[^\d.]/g, ''))}
                    placeholder={suggested != null ? String(suggested) : ''}
                    aria-label="Goal"
                  />
                  <span>
                    {unit}
                    {kind === 'target'
                      ? ' in total'
                      : kind === 'average'
                        ? ' a day, on average'
                        : ' a day to count'}
                  </span>
                </label>
                {kind === 'streak' && (
                  <label className="input">
                    <input
                      inputMode="numeric"
                      value={streakDays}
                      onChange={(e) => setStreakDays(e.target.value.replace(/\D/g, ''))}
                      aria-label="Streak length"
                    />
                    <span>days in a row</span>
                  </label>
                )}
              </div>
            )}
          </>
        ) : (
          <>
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
          </>
        )}

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

        {!solo && (
          <>
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
              {friends.data?.friends.length ? 'Tap friends to invite them. ' : ''}You can share a
              link to the challenge once it's created.
            </p>
          </>
        )}

        {!solo && (
          <>
            <TeamsSetup
              value={teams}
              onChange={setTeams}
              lowerIsBetter={isCustom ? customLower : !!def?.lowerIsBetter}
            />
            <RepeatSetup value={repeat} onChange={setRepeat} days={daysBetween(start, end) + 1} />
          </>
        )}

        <div className="lbl">Show events</div>
        <div className="card stack" style={{ gap: 6 }}>
          <div className="row">
            <div className="grow">
              <div style={{ fontWeight: 700 }}>Show what counted</div>
              <small className="muted">
                {showEvents
                  ? solo
                    ? 'Open the workouts, sets and fasts behind your progress.'
                    : 'Participants can open the workouts, sets and fasts behind each score. People can switch this off for themselves in Privacy.'
                  : 'Only totals are shown.'}
              </small>
            </div>
            <Toggle checked={showEvents} onChange={setShowEvents} label="Show events" />
          </div>
        </div>

        {!solo && (
          <>
            <div className="lbl">Side bet</div>
            <StakeField value={stake} onChange={setStake} />
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
          </>
        )}

        <div className="dock stack">
          <ErrorBox
            error={
              error ??
              (ruleProblem
                ? new Error(ruleProblem)
                : soloProblem
                  ? new Error(soloProblem)
                  : extraProblem
                    ? new Error(extraProblem)
                    : null)
            }
          />
          <button
            className="btn"
            disabled={
              busy ||
              !!ruleProblem ||
              !!soloProblem ||
              !!extraProblem ||
              !!datesProblem ||
              !scoringOk ||
              (isCustom && !customChoice) ||
              (isLift && !lift) ||
              (needsTarget && !weightGoal)
            }
          >
            {busy ? (
              <span className="spinner" />
            ) : solo ? (
              'Start solo challenge'
            ) : (
              'Start challenge'
            )}
          </button>
        </div>
      </form>
    </Screen>
  );
}
