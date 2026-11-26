import { BACKUP_FREQUENCIES, type BackupSchedule } from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { put } from '../lib/api';
import { adminKeys } from '../lib/admin';
import { ErrorBox, toast } from './ui';

const FREQ_LABEL: Record<BackupSchedule['frequency'], string> = {
  off: 'Off',
  hourly: 'Every hour',
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
};
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

function clock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Every Sunday at 4:00 AM · keeps 14 · deletes after 30 days", for the backup summary. */
export function describeSchedule(s: BackupSchedule): string {
  const when =
    s.frequency === 'off'
      ? 'Automatic backups are off'
      : s.frequency === 'hourly'
        ? `Every hour at :${s.time.slice(3)}`
        : s.frequency === 'daily'
          ? `Every day at ${clock(s.time)}`
          : s.frequency === 'weekly'
            ? `Every ${WEEKDAYS[s.weekday]} at ${clock(s.time)}`
            : `On the ${ordinal(s.dayOfMonth)} of each month at ${clock(s.time)}`;
  const keep = s.keepCount > 0 ? `keeps the newest ${s.keepCount}` : 'keeps all automatic ones';
  const age = s.keepDays > 0 ? ` · deletes backups after ${s.keepDays} days` : '';
  return `${when} · ${keep}${age}`;
}

/** Admin: how often automatic backups run and how long backups are kept. */
export function BackupScheduleCard({ schedule }: { schedule: BackupSchedule }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(schedule);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Follow the server when it changes (e.g. after saving), unless there are unsaved edits.
  const [base, setBase] = useState(schedule);
  useEffect(() => {
    if (JSON.stringify(schedule) !== JSON.stringify(base)) {
      setBase(schedule);
      setDraft(schedule);
    }
  }, [schedule, base]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const set = <K extends keyof BackupSchedule>(k: K, v: BackupSchedule[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const num = (v: string, max: number) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await put('/api/admin/backups/schedule', draft);
      await qc.invalidateQueries({ queryKey: adminKeys.backups });
      toast('Backup schedule saved');
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  const f = draft.frequency;
  return (
    <div className="card stack" style={{ gap: 12 }}>
      <div style={{ fontWeight: 700 }}>Schedule and clean-up</div>
      <ErrorBox error={error} />
      <div className="adm-form">
        <label>
          <span>Automatic backups</span>
          <select value={f} onChange={(e) => set('frequency', e.target.value as typeof f)}>
            {BACKUP_FREQUENCIES.map((x) => (
              <option key={x} value={x}>
                {FREQ_LABEL[x]}
              </option>
            ))}
          </select>
        </label>
        {f === 'weekly' && (
          <label>
            <span>On</span>
            <select value={draft.weekday} onChange={(e) => set('weekday', Number(e.target.value))}>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        )}
        {f === 'monthly' && (
          <label>
            <span>On day</span>
            <select
              value={draft.dayOfMonth}
              onChange={(e) => set('dayOfMonth', Number(e.target.value))}
            >
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {ordinal(d)}
                </option>
              ))}
            </select>
          </label>
        )}
        {f !== 'off' && (
          <label>
            <span>{f === 'hourly' ? 'At minute' : 'At'}</span>
            {f === 'hourly' ? (
              <select
                value={draft.time.slice(3)}
                onChange={(e) => set('time', `${draft.time.slice(0, 2)}:${e.target.value}`)}
              >
                {['00', '15', '30', '45'].map((m) => (
                  <option key={m} value={m}>
                    :{m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="time"
                value={draft.time}
                onChange={(e) => e.target.value && set('time', e.target.value.slice(0, 5))}
              />
            )}
          </label>
        )}
        <label>
          <span>Keep the newest</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={1000}
            value={draft.keepCount}
            onChange={(e) => set('keepCount', num(e.target.value, 1000))}
            aria-describedby="keep-help"
          />
        </label>
        <label>
          <span>Delete after (days)</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={3650}
            value={draft.keepDays}
            onChange={(e) => set('keepDays', num(e.target.value, 3650))}
            aria-describedby="keep-help"
          />
        </label>
      </div>
      <small id="keep-help" className="muted" style={{ lineHeight: 1.5 }}>
        "Keep the newest" counts automatic backups (0 keeps them all). "Delete after" removes
        automatic, manual and safety copies older than that (0 never deletes by age). The newest
        backup is always kept, and uploaded backups are only deleted by you. Times follow the
        server's time zone.
      </small>
      <button className="btn sm" onClick={save} disabled={!dirty || saving}>
        {saving ? 'Saving…' : 'Save schedule'}
      </button>
    </div>
  );
}
