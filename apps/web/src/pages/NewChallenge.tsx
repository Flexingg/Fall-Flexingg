import {
  addDays,
  BUILTIN_METRICS,
  METRICS,
  SCORING_LABELS,
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
import { Avatar, ErrorBox, Header, Screen, Seg, Toggle } from '../components/ui';
import { post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateRange } from '../lib/format';
import { timezone } from '../lib/platform';
import { useCustomMetrics, useFriends } from '../lib/queries';

type Duration = '3' | 'weekend' | '7' | '30';
const CUSTOM = 'custom' as const;

function window(duration: Duration, today: string): { start: string; end: string } {
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
};

const DAILY_TARGETS: Partial<Record<MetricKey, number>> = {
  steps: 10_000,
  distance: 5,
  active_minutes: 30,
  active_calories: 500,
  workouts: 1,
  sleep: 7,
  resting_hr: 60,
};

export function NewChallengePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const friends = useFriends();
  const [name, setName] = useState('');
  const [metric, setMetric] = useState<MetricKey | typeof CUSTOM>('distance');
  const [customId, setCustomId] = useState('');
  const [customAgg, setCustomAgg] = useState<'sum' | 'avg'>('sum');
  const [customLower, setCustomLower] = useState(false);
  const [scoring, setScoring] = useState<ScoringMode>('total');
  const [goal, setGoal] = useState('');
  const [duration, setDuration] = useState<Duration>('7');
  const [invited, setInvited] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const customMetrics = useCustomMetrics(metric === CUSTOM);

  const today = todayIn(timezone);
  const { start, end } = window(duration, today);
  const isCustom = metric === CUSTOM;
  const def = isCustom ? null : METRICS[metric as keyof typeof METRICS];
  const aggregate = isCustom ? customAgg : (def?.aggregate ?? 'sum');
  const customChoice = customMetrics.data?.find((m) => m.categoryId === customId);
  const unit = isCustom ? (customChoice?.unit ?? '') : (def?.unit ?? '');
  const suggested = scoring === 'streak' ? DAILY_TARGETS[metric as MetricKey] : scoring === 'race_to_goal' ? DEFAULT_GOALS[metric as MetricKey] : undefined;
  const goalNum = goal.trim() ? Number(goal) : (suggested ?? null);
  const ruleProblem = validateRules({ scoring, aggregate, goal: goalNum });
  const scoringOptions = useMemo(
    () => (Object.keys(SCORING_LABELS) as ScoringMode[]).filter((s) => aggregate === 'sum' || s !== 'race_to_goal'),
    [aggregate],
  );
  const placeholderName = isCustom ? (customChoice?.label ?? 'Custom') : `${def?.label} ${duration === 'weekend' ? 'Weekend' : `${duration}-Day`}`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: CreateChallengeRequest = {
        name: name.trim() || placeholderName,
        metric: isCustom ? (`custom:${customChoice?.label.toLowerCase() ?? 'x'}` as MetricKey) : (metric as MetricKey),
        custom: isCustom && customChoice ? { categoryId: customChoice.categoryId, label: customChoice.label, unit: customChoice.unit ?? undefined, aggregate: customAgg, lowerIsBetter: customLower } : undefined,
        scoring,
        goal: goalNum,
        startDate: start,
        endDate: end,
        timezone,
        inviteUserIds: [...invited],
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

  const tiles: { key: MetricKey | typeof CUSTOM; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
    ...BUILTIN_METRICS.map((k) => ({ key: k, label: METRICS[k].label, icon: METRICS[k].icon })),
    { key: CUSTOM, label: 'Custom', icon: 'plus' },
  ];

  return (
    <Screen>
      <Header title="New challenge" back="/challenges" />
      <form onSubmit={submit}>
        <label className="input">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholderName} maxLength={60} aria-label="Challenge name" />
          <span>Name</span>
        </label>

        <div className="lbl">Metric</div>
        <div className="metric-grid">
          {tiles.map((t) => (
            <button
              key={t.key}
              type="button"
              aria-pressed={metric === t.key}
              onClick={() => {
                setMetric(t.key);
                if (t.key !== CUSTOM && METRICS[t.key as keyof typeof METRICS].aggregate === 'avg' && scoring === 'race_to_goal') setScoring('total');
              }}
            >
              <Icon name={t.icon} size={22} />
              {t.label}
            </button>
          ))}
        </div>

        {isCustom && (
          <div className="stack" style={{ marginTop: 10 }}>
            <label className="input">
              <select value={customId} onChange={(e) => setCustomId(e.target.value)} aria-label="Custom metric" required>
                <option value="">{customMetrics.isPending ? 'Loading your SparkyFitness metrics…' : 'Choose a SparkyFitness metric'}</option>
                {customMetrics.data?.map((m) => (
                  <option key={m.categoryId} value={m.categoryId}>
                    {m.label}
                    {m.unit ? ` (${m.unit})` : ''}
                  </option>
                ))}
              </select>
            </label>
            {customMetrics.data?.length === 0 && <div className="notice">No custom measurements found. Create one in SparkyFitness under Check-in → Custom measurements.</div>}
            <Seg label="Combine days by" value={customAgg} onChange={setCustomAgg} options={[{ value: 'sum', label: 'Add up days' }, { value: 'avg', label: 'Average days' }]} />
            <div className="row card" style={{ padding: '10px 14px' }}>
              <span className="grow" style={{ fontSize: 14, fontWeight: 600 }}>Lower is better</span>
              <Toggle checked={customLower} onChange={setCustomLower} label="Lower is better" />
            </div>
          </div>
        )}

        <div className="lbl">How to win</div>
        <label className="input">
          <select value={scoring} onChange={(e) => setScoring(e.target.value as ScoringMode)} aria-label="How to win">
            {scoringOptions.map((s) => (
              <option key={s} value={s}>
                {SCORING_LABELS[s]}
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
            {scoring === 'race_to_goal' ? ' · first to reach it wins' : scoring === 'streak' ? ' per day' : scoring === 'total' ? ' · optional' : ''}
          </span>
        </label>

        <div className="lbl">
          <span>Duration</span>
          <span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>{dateRange(start, end)}</span>
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
          ]}
        />

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
                onClick={() => setInvited((s) => {
                  const n = new Set(s);
                  if (on) n.delete(f.id);
                  else n.add(f.id);
                  return n;
                })}
                style={{ borderRadius: '50%', outline: on ? '2px solid var(--volt)' : 'none', outlineOffset: 2, color: on ? 'var(--volt)' : undefined }}
              >
                <Avatar user={f} size={42} />
              </button>
            );
          })}
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          {friends.data?.friends.length ? 'Tap friends to invite them. ' : ''}You can share a link to the challenge once it's created.
        </p>

        <div className="dock stack">
          <ErrorBox error={error ?? (ruleProblem ? new Error(ruleProblem) : null)} />
          <button className="btn" disabled={busy || !!ruleProblem || (isCustom && !customChoice)}>
            {busy ? <span className="spinner" /> : 'Start challenge'}
          </button>
        </div>
      </form>
    </Screen>
  );
}
