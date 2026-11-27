/**
 * Admin → Badges editor: one form for a new badge, an existing one, or a Garmin idea someone is
 * approving. A rule builder in plain words instead of JSON, the same checks the server runs shown
 * inline, a preview of who would earn it today, and Save draft / Publish / Retire / Delete.
 */
import {
  ACTIVITY_MEASURES,
  BADGE_DAY_METRICS,
  BADGE_FAMILIES,
  BADGE_FAMILY_LABELS,
  BADGE_ICONS,
  CHALLENGE_DRAMA,
  SOCIAL_EVENTS,
  badgeMetricLabel,
  describeRule,
  SPORT_CHOICES,
  tierName,
  type AdminBadge,
  type BadgePreviewResponse,
  type BadgeSuggestion,
} from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { adminBadgeKeys } from '../lib/adminBadges';
import { ApiError, del, post, put } from '../lib/api';
import {
  RULE_TYPES,
  TIERED,
  defaultFields,
  draftToForm,
  emptyForm,
  formToRaw,
  keyFromName,
  validateDraft,
  type DraftErrors,
  type DraftForm,
  type RuleFields,
} from '../lib/badgeEditor';
import { cap } from '../lib/badges';
import { BadgeIcon } from './BadgeIcon';
import { ErrorBox, Header, toast } from './ui';
import '../styles/admin.css';
import '../styles/badges-admin.css';

export type EditorMode =
  | { kind: 'new' }
  | { kind: 'edit'; badge: AdminBadge }
  | { kind: 'suggestion'; suggestion: BadgeSuggestion };

const MEASURE_LABEL: Record<string, string> = {
  distance_km: 'Distance (km)',
  minutes: 'Time (minutes)',
  kcal: 'Calories (kcal)',
};
const EVENT_LABEL: Record<string, string> = {
  reactions_sent: 'Reactions sent',
  comments_sent: 'Comments sent',
  challenges_created: 'Challenges created',
  challenges_joined: 'Challenges joined',
  team_challenges_joined: 'Team challenges joined',
  friends: 'Friends made',
  invite_joins: 'People who joined through your invite',
  stakes_paid: 'Side bets paid',
  rematches_won: 'Rematches won',
  personal_records: 'Personal records set',
};
const DRAMA_LABEL: Record<string, string> = {
  comeback: 'Come from behind to win',
  photo_finish: 'Win a photo finish',
  wire_to_wire: 'Lead from the first day to the last',
  giant_killer: 'Beat a much stronger field',
};
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function Field({
  label,
  error,
  children,
  full,
  hint,
}: {
  label: string;
  error?: string;
  children: ReactNode;
  full?: boolean;
  hint?: string;
}) {
  return (
    <label className={full ? 'full' : undefined}>
      <span>{label}</span>
      {children}
      {hint && <small className="muted bde-hint">{hint}</small>}
      {error && (
        <small className="bde-err" role="alert">
          {error}
        </small>
      )}
    </label>
  );
}

function Check({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="bde-check full">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <small className="muted bde-hint">{hint}</small>}
      </span>
    </label>
  );
}

/** The rule builder: pick what kind of rule, then fill in only the fields that kind needs. */
function RuleBuilder({
  f,
  set,
  error,
}: {
  f: RuleFields;
  set: (p: Partial<RuleFields>) => void;
  error?: string;
}) {
  const t = f.type;
  const usesMetric = [
    'lifetime_total',
    'best_period',
    'streak',
    'count_days',
    'date_active',
  ].includes(t);
  const usesSport = ['single_activity', 'activity_count', 'activity_total'].includes(t);
  const usesHours = ['count_days', 'single_activity', 'activity_count'].includes(t);
  const lift = f.metric === 'lift_max' || f.metric === 'lift_e1rm';
  const tierName_ = (i: number) =>
    f.tiers.length > 1 ? cap(tierName(i + 1, f.tiers.length) ?? '') : 'Target';
  return (
    <div className="adm-form one">
      <Field label="What earns it" hint={RULE_TYPES.find((r) => r.value === t)?.hint}>
        <select
          value={t}
          onChange={(e) => set({ ...defaultFields(e.target.value as RuleFields['type']) })}
          aria-label="Rule type"
        >
          {RULE_TYPES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </Field>

      {usesMetric && (
        <Field
          label="Measured by"
          hint="Distance is in km, weight in kg, sleep in hours, water in litres."
        >
          <select
            value={f.metric}
            onChange={(e) => set({ metric: e.target.value })}
            aria-label="Metric"
          >
            {BADGE_DAY_METRICS.map((m) => (
              <option key={m} value={m}>
                {cap(badgeMetricLabel(m))}
              </option>
            ))}
            <option value="lift_max">A lift: heaviest weight</option>
            <option value="lift_e1rm">A lift: estimated 1-rep max</option>
          </select>
        </Field>
      )}
      {usesMetric && lift && (
        <Field
          label="Exercise name"
          hint="Exactly as it appears in your workouts, like Bench Press."
        >
          <input
            value={f.lift}
            onChange={(e) => set({ lift: e.target.value })}
            placeholder="Bench Press"
            aria-label="Exercise name"
            maxLength={60}
          />
        </Field>
      )}

      {t === 'best_period' && (
        <Field label="Best of">
          <select
            value={f.period}
            onChange={(e) => set({ period: e.target.value as RuleFields['period'] })}
            aria-label="Period"
          >
            <option value="day">One day</option>
            <option value="week">One week (Mon to Sun)</option>
            <option value="month">One month</option>
          </select>
        </Field>
      )}

      {(t === 'streak' ||
        t === 'count_days' ||
        t === 'date_active' ||
        (t === 'activity_count' && f.sized)) && (
        <Field
          label={
            t === 'activity_count'
              ? 'Each workout at least'
              : t === 'date_active'
                ? 'At least'
                : 'A day counts at'
          }
        >
          <input
            type="number"
            inputMode="decimal"
            min={0}
            value={f.min}
            onChange={(e) => set({ min: e.target.value })}
            aria-label="Minimum"
          />
        </Field>
      )}

      {usesSport && (
        <Field label="Activity">
          <select
            value={f.sport}
            onChange={(e) => set({ sport: e.target.value as RuleFields['sport'] })}
            aria-label="Sport"
          >
            {SPORT_CHOICES.map((s) => (
              <option key={s.value} value={s.value}>
                {cap(s.label)}
              </option>
            ))}
          </select>
        </Field>
      )}
      {(t === 'single_activity' ||
        t === 'activity_total' ||
        (t === 'activity_count' && f.sized)) && (
        <Field label="Measured in">
          <select
            value={f.measure}
            onChange={(e) => set({ measure: e.target.value as RuleFields['measure'] })}
            aria-label="Measure"
          >
            {ACTIVITY_MEASURES.map((m) => (
              <option key={m} value={m}>
                {MEASURE_LABEL[m]}
              </option>
            ))}
          </select>
        </Field>
      )}
      {t === 'activity_count' && (
        <Check
          label="Only count bigger workouts"
          checked={f.sized}
          onChange={(v) => set({ sized: v, min: v && !f.min ? '5' : f.min })}
        />
      )}

      {usesHours && (
        <>
          <Check
            label="Only at certain times of day"
            checked={f.hoursOn}
            onChange={(v) => set({ hoursOn: v })}
          />
          {f.hoursOn && (
            <>
              <Field label="From hour (0 to 23)">
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={23}
                  value={f.hoursFrom}
                  onChange={(e) => set({ hoursFrom: e.target.value })}
                  aria-label="From hour"
                />
              </Field>
              <Field label="Until hour (1 to 24)" hint="Local time. 22 to 4 runs through midnight.">
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={24}
                  value={f.hoursTo}
                  onChange={(e) => set({ hoursTo: e.target.value })}
                  aria-label="To hour"
                />
              </Field>
            </>
          )}
        </>
      )}

      {t === 'challenge_result' && (
        <>
          <Field label="Result">
            <select
              value={f.place}
              onChange={(e) => set({ place: e.target.value as RuleFields['place'] })}
              aria-label="Place"
            >
              <option value="">Finished with a score</option>
              <option value="1">Won (1st place)</option>
              <option value="3">Finished on the podium (top 3)</option>
            </select>
          </Field>
          <Field label="Special kind of finish">
            <select
              value={f.drama}
              onChange={(e) => set({ drama: e.target.value as RuleFields['drama'] })}
              aria-label="Drama"
            >
              <option value="">Any</option>
              {CHALLENGE_DRAMA.map((d) => (
                <option key={d} value={d}>
                  {DRAMA_LABEL[d]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="At least this many people">
            <input
              type="number"
              inputMode="numeric"
              min={2}
              value={f.minParticipants}
              onChange={(e) => set({ minParticipants: e.target.value })}
              placeholder="Any"
              aria-label="Minimum people"
            />
          </Field>
          <Check
            label="Team challenges only"
            checked={f.teamOnly}
            onChange={(v) => set({ teamOnly: v })}
          />
        </>
      )}

      {t === 'social' && (
        <Field label="Count">
          <select
            value={f.event}
            onChange={(e) => set({ event: e.target.value as RuleFields['event'] })}
            aria-label="Social event"
          >
            {SOCIAL_EVENTS.map((s) => (
              <option key={s} value={s}>
                {EVENT_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>
      )}

      {t === 'date_active' && (
        <>
          <Field label="Month">
            <select
              value={f.month}
              onChange={(e) => set({ month: e.target.value })}
              aria-label="Month"
            >
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Day">
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={31}
              value={f.day}
              onChange={(e) => set({ day: e.target.value })}
              aria-label="Day of month"
            />
          </Field>
        </>
      )}

      {TIERED.includes(t) && (
        <div className="full">
          <span className="bde-label">Tiers, smallest first</span>
          <div className="bde-tiers">
            {f.tiers.map((v, i) => (
              <label key={i}>
                <span>{tierName_(i)}</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  value={v}
                  aria-label={`Tier ${i + 1}`}
                  onChange={(e) =>
                    set({ tiers: f.tiers.map((x, j) => (j === i ? e.target.value : x)) })
                  }
                />
              </label>
            ))}
          </div>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            {f.tiers.length < 4 && (
              <button
                type="button"
                className="btn secondary sm"
                onClick={() => set({ tiers: [...f.tiers, ''] })}
              >
                Add a tier
              </button>
            )}
            {f.tiers.length > 1 && (
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => set({ tiers: f.tiers.slice(0, -1) })}
              >
                Remove last tier
              </button>
            )}
          </div>
          <small className="muted bde-hint">
            One tier is a single medal. Two to four tiers give bronze, silver, gold and platinum.
          </small>
        </div>
      )}
      {error && (
        <small className="bde-err full" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}

export function ConfirmSheet({
  title,
  children,
  confirm,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirm: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="adm-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="card stack adm-dialog" style={{ gap: 10 }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>
          {children}
        </p>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className={`btn${danger ? ' danger' : ''}`} onClick={onConfirm} disabled={busy}>
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

const fileToBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('Could not read that file'));
    r.readAsDataURL(file);
  });

export function BadgeEditor({
  mode,
  onClose,
  onSaved,
}: {
  mode: EditorMode;
  onClose: () => void;
  onSaved: (b: AdminBadge) => void;
}) {
  const qc = useQueryClient();
  const saved = mode.kind === 'edit' ? mode.badge : null;
  const initial = useMemo<DraftForm>(
    () =>
      mode.kind === 'edit'
        ? draftToForm(mode.badge)
        : mode.kind === 'suggestion' && mode.suggestion.draft
          ? draftToForm(mode.suggestion.draft)
          : emptyForm(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [form, setForm] = useState<DraftForm>(initial);
  const [keyTouched, setKeyTouched] = useState(mode.kind !== 'new');
  const [errors, setErrors] = useState<DraftErrors>({});
  const [serverError, setServerError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<BadgePreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirm, setConfirm] = useState<'publish' | 'retire' | 'delete' | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<unknown>(null);
  const file = useRef<HTMLInputElement>(null);

  const status = saved?.status ?? null;
  const dirty = JSON.stringify(formToRaw(form)) !== JSON.stringify(formToRaw(initial));
  const [attempted, setAttempted] = useState(false);
  const set = (p: Partial<DraftForm>) => {
    const next = { ...form, ...p };
    setForm(next);
    setPreview(null);
    // After a first try, the messages follow the form as it is fixed.
    if (attempted) {
      const r = validateDraft(next);
      setErrors(r.ok ? {} : r.errors);
    }
  };
  const setRule = (p: Partial<RuleFields>) => set({ rule: { ...form.rule, ...p } });
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: adminBadgeKeys.list }),
      qc.invalidateQueries({ queryKey: adminBadgeKeys.suggestionsAll }),
      qc.invalidateQueries({ queryKey: adminBadgeKeys.status }),
    ]);

  function check() {
    setAttempted(true);
    const r = validateDraft(form);
    setErrors(r.ok ? {} : r.errors);
    setServerError(null);
    return r.ok ? r.draft : null;
  }

  async function save() {
    const draft = check();
    if (!draft) return;
    setBusy(true);
    try {
      let badge: AdminBadge;
      if (mode.kind === 'edit')
        badge = await put<AdminBadge>(`/api/admin/badges/${mode.badge.key}`, draft);
      else if (mode.kind === 'suggestion')
        badge = (
          await post<{ badge: AdminBadge }>(
            `/api/admin/badge-suggestions/${mode.suggestion.id}/approve`,
            { draft },
          )
        ).badge;
      else badge = await post<AdminBadge>('/api/admin/badges', draft);
      await refresh();
      toast(mode.kind === 'edit' ? 'Saved' : 'Saved as a draft');
      onSaved(badge);
    } catch (err) {
      setServerError(err);
    } finally {
      setBusy(false);
    }
  }

  async function runPreview() {
    const draft = check();
    if (!draft) return;
    setPreviewing(true);
    try {
      setPreview(await post<BadgePreviewResponse>('/api/admin/badges/preview', draft));
    } catch (err) {
      setServerError(err);
    } finally {
      setPreviewing(false);
    }
  }

  async function action(kind: 'publish' | 'retire' | 'delete') {
    if (!saved) return;
    setBusy(true);
    setServerError(null);
    try {
      if (kind === 'delete') {
        await del(`/api/admin/badges/${saved.key}`);
        await refresh();
        toast('Draft deleted');
        onClose();
        return;
      }
      const badge = await post<AdminBadge>(`/api/admin/badges/${saved.key}/${kind}`);
      await refresh();
      toast(kind === 'publish' ? 'Published. It is being awarded quietly.' : 'Retired');
      setConfirm(null);
      onSaved(badge);
    } catch (err) {
      setConfirm(null);
      setServerError(err);
    } finally {
      setBusy(false);
    }
  }

  async function upload(f: File | undefined) {
    if (!f) return;
    setUploading(true);
    setUploadError(null);
    try {
      const data = await fileToBase64(f);
      const { url } = await post<{ url: string }>('/api/admin/badges/images', {
        mime: f.type,
        data,
      });
      set({ imageUrl: url });
    } catch (err) {
      setUploadError(err);
    } finally {
      setUploading(false);
      if (file.current) file.current.value = '';
    }
  }

  const title =
    mode.kind === 'edit' ? 'Edit badge' : mode.kind === 'suggestion' ? 'Approve idea' : 'New badge';
  const draftOk = validateDraft(form);
  const tiersCount = draftOk.ok
    ? 'tiers' in draftOk.draft.rule
      ? draftOk.draft.rule.tiers.length
      : 1
    : form.rule.tiers.length || 1;
  const sentence = draftOk.ok ? describeRule(draftOk.draft.rule, draftOk.draft.window) : null;

  return (
    <>
      <Header
        title={title}
        back={undefined}
        action={
          <button className="btn ghost sm" onClick={onClose}>
            Close
          </button>
        }
      />
      {mode.kind === 'suggestion' && (
        <div className="card bde-source">
          <small className="muted">Garmin idea (for reference only)</small>
          <b>{mode.suggestion.source.name}</b>
          <small className="muted">{mode.suggestion.source.description}</small>
        </div>
      )}
      <div className="card stack" style={{ gap: 14, marginTop: 12 }}>
        <div className="bde-hero">
          <BadgeIcon
            icon={form.icon}
            imageUrl={form.imageUrl}
            medal={tiersCount > 1 ? 'gold' : 'single'}
            size="lg"
          />
          <div className="grow">
            <b className="ellipsis" style={{ display: 'block', fontSize: 18 }}>
              {form.name || 'Badge name'}
            </b>
            <small className="muted">
              {form.description.replace(/\{n\}/g, '…') || 'What to do to earn it'}
            </small>
            {sentence && <small className="bde-rule">{sentence}</small>}
          </div>
        </div>
        {status && (
          <small className="muted">
            Status: <b>{cap(status)}</b>
            {saved
              ? ` · ${saved.earnedBy} ${saved.earnedBy === 1 ? 'person has' : 'people have'} it`
              : ''}
          </small>
        )}

        <div className="adm-form one">
          <Field label="Name" error={errors.name}>
            <input
              value={form.name}
              maxLength={40}
              aria-label="Name"
              onChange={(e) =>
                set({
                  name: e.target.value,
                  ...(keyTouched ? {} : { key: keyFromName(e.target.value) }),
                })
              }
            />
          </Field>
          <Field
            label="Key"
            error={errors.key}
            hint={
              saved
                ? "The key can't change once a badge is saved."
                : 'A short id, made from the name. It can not be changed later.'
            }
          >
            <input
              value={form.key}
              disabled={!!saved}
              aria-label="Key"
              autoCapitalize="none"
              autoComplete="off"
              onChange={(e) => {
                setKeyTouched(true);
                set({ key: e.target.value });
              }}
            />
          </Field>
          <Field
            label="Description"
            error={errors.description}
            hint="One plain sentence. Use {n} where the tier's number goes, like “Walk {n} steps in total.”"
          >
            <textarea
              rows={2}
              maxLength={160}
              value={form.description}
              aria-label="Description"
              onChange={(e) => set({ description: e.target.value })}
            />
          </Field>
          <Field label="Group">
            <select
              value={form.family}
              onChange={(e) => set({ family: e.target.value as DraftForm['family'] })}
              aria-label="Group"
            >
              {BADGE_FAMILIES.map((f) => (
                <option key={f} value={f}>
                  {BADGE_FAMILY_LABELS[f]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div>
          <span className="bde-label">Picture</span>
          <div className="bde-icons" role="group" aria-label="Icon">
            {BADGE_ICONS.map((i) => (
              <button
                key={i}
                type="button"
                aria-label={`Icon ${i}`}
                aria-pressed={!form.imageUrl && form.icon === i}
                className="bde-icon"
                onClick={() => set({ icon: i, imageUrl: null })}
              >
                <BadgeIcon icon={i} medal="gold" size={40} />
              </button>
            ))}
          </div>
          <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <input
              ref={file}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              hidden
              aria-label="Image file"
              onChange={(e) => void upload(e.target.files?.[0])}
            />
            <button
              type="button"
              className="btn secondary sm"
              disabled={uploading}
              onClick={() => file.current?.click()}
            >
              {uploading ? 'Uploading…' : 'Upload image'}
            </button>
            {form.imageUrl && (
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => set({ imageUrl: null })}
              >
                Use an icon instead
              </button>
            )}
            <small className="muted">PNG, JPG, WebP or SVG, up to 256 KB.</small>
          </div>
          <ErrorBox error={uploadError} />
        </div>

        <RuleBuilder f={form.rule} set={setRule} error={errors.rule} />

        <div className="adm-form one">
          <Check
            label="Secret badge"
            hint="Shows as “?” until someone earns it."
            checked={form.secret}
            onChange={(v) => set({ secret: v })}
          />
          <Check
            label="Count entries typed in by hand"
            hint="Turn off to ignore manually entered workouts. Challenge rules never count them."
            checked={form.countsManual}
            onChange={(v) => set({ countsManual: v })}
          />
          <Check
            label="Limited time"
            hint="Only activity inside these dates counts, and it can only be earned then."
            checked={form.limited}
            onChange={(v) => set({ limited: v })}
          />
          {form.limited && (
            <>
              <Field label="Starts" error={errors.window}>
                <input
                  type="date"
                  value={form.windowStart}
                  onChange={(e) => set({ windowStart: e.target.value })}
                  aria-label="Starts"
                />
              </Field>
              <Field label="Ends">
                <input
                  type="date"
                  value={form.windowEnd}
                  onChange={(e) => set({ windowEnd: e.target.value })}
                  aria-label="Ends"
                />
              </Field>
            </>
          )}
        </div>

        <details className="bde-adv">
          <summary>Advanced: XP per tier</summary>
          <small className="muted bde-hint">
            Leave empty for the usual amounts (10, 25, 60 and 150 for four tiers; 25 for one).
          </small>
          <div className="bde-tiers">
            {Array.from({ length: tiersCount }, (_, i) => (
              <label key={i}>
                <span>Tier {i + 1}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={1000}
                  value={form.xp[i] ?? ''}
                  aria-label={`XP for tier ${i + 1}`}
                  onChange={(e) => {
                    const xp = Array.from({ length: tiersCount }, (_, j) =>
                      j === i ? e.target.value : (form.xp[j] ?? ''),
                    );
                    set({ xp });
                  }}
                />
              </label>
            ))}
          </div>
          {errors.xp && (
            <small className="bde-err" role="alert">
              {errors.xp}
            </small>
          )}
        </details>
      </div>

      <ErrorBox error={serverError} />
      {serverError instanceof ApiError && serverError.code === 'badge_exists' && (
        <small className="muted">Change the key above and save again.</small>
      )}

      {preview && (
        <div
          className="card stack bde-preview"
          style={{ gap: 6, marginTop: 12 }}
          data-testid="badge-preview"
        >
          <b>
            {preview.wouldEarn === 0
              ? 'Nobody would earn it right now'
              : `Would award ${preview.wouldEarn} ${preview.wouldEarn === 1 ? 'person' : 'people'} now`}
          </b>
          {preview.wouldEarn > 0 && (
            <>
              <small className="muted">
                {preview.byTier
                  .map((n, i) => ({
                    n,
                    name:
                      tiersCount > 1 ? cap(tierName(i + 1, preview.byTier.length) ?? '') : 'Earned',
                  }))
                  .filter((x) => x.n > 0)
                  .map((x) => `${x.name} ${x.n}`)
                  .join(' · ')}
              </small>
              <small>
                {preview.sample
                  .map(
                    (s) =>
                      `${s.user.displayName.split(' ')[0]} (${tiersCount > 1 ? cap(tierName(s.tier, tiersCount) ?? '') : 'Earned'})`,
                  )
                  .join(', ')}
                {preview.wouldEarn > preview.sample.length ? '…' : ''}
              </small>
            </>
          )}
        </div>
      )}

      <div className="stack" style={{ gap: 8, marginTop: 14 }}>
        <button
          className="btn secondary"
          onClick={() => void runPreview()}
          disabled={previewing || busy}
        >
          {previewing ? 'Checking…' : 'Preview who would earn it'}
        </button>
        <button className="btn" onClick={() => void save()} disabled={busy || (!!saved && !dirty)}>
          {busy ? 'Saving…' : saved ? 'Save changes' : 'Save draft'}
        </button>
        {saved && saved.status !== 'live' && (
          <button
            className="btn"
            onClick={() => setConfirm('publish')}
            disabled={busy || dirty}
            title={dirty ? 'Save your changes first' : undefined}
          >
            {dirty
              ? 'Save changes to publish'
              : saved.status === 'retired'
                ? 'Publish again'
                : 'Publish'}
          </button>
        )}
        {saved?.status === 'live' && (
          <button className="btn danger" onClick={() => setConfirm('retire')} disabled={busy}>
            Retire
          </button>
        )}
        {saved?.status === 'draft' && (
          <button className="btn danger" onClick={() => setConfirm('delete')} disabled={busy}>
            Delete draft
          </button>
        )}
      </div>

      {confirm === 'publish' && (
        <ConfirmSheet
          title="Publish this badge?"
          confirm="Publish"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void action('publish')}
        >
          Publishing awards it quietly to everyone who already qualifies. They will not get a
          celebration, and it can show up for friends right away.
        </ConfirmSheet>
      )}
      {confirm === 'retire' && (
        <ConfirmSheet
          title="Retire this badge?"
          confirm="Retire"
          danger
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void action('retire')}
        >
          People who earned it keep it. Nobody new can earn it, and it stops showing for people who
          haven't.
        </ConfirmSheet>
      )}
      {confirm === 'delete' && (
        <ConfirmSheet
          title="Delete this draft?"
          confirm="Delete"
          danger
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void action('delete')}
        >
          The draft is removed for good. Nobody has earned it, so nothing else changes.
        </ConfirmSheet>
      )}
    </>
  );
}
