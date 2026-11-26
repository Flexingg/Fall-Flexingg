import {
  formatDistanceKm,
  formatNumber,
  formatTime,
  formatWeightKg,
  NUMBER_LOCALES,
  type ClockFormat,
  type UnitSystem,
} from '@gauntlet/shared';
import { useAuth } from '../lib/auth';
import { chooseDisplay, useDisplay } from '../lib/display';
import { deviceLocale } from '../lib/platform';
import { updateSettings } from '../lib/session';
import { Seg, toast } from './ui';

/**
 * Units (km/kg or mi/lb), the clock (12 or 24 hour) and the number format. Choices apply at once
 * and are saved to the account so notifications and the weekly recap are worded the same way. The
 * shared demo account can't save, so its choices stay in this browser.
 */
export function DisplaySettings() {
  const { user, setUser } = useAuth();
  const d = useDisplay();
  const locales = NUMBER_LOCALES.some((l) => l.locale === deviceLocale)
    ? NUMBER_LOCALES
    : [
        { locale: deviceLocale, example: formatNumber(1234.5, { locale: deviceLocale }, 1) },
        ...NUMBER_LOCALES,
      ];
  const picked = locales.some((l) => l.locale === d.locale) ? d.locale : locales[0]!.locale;

  async function change(patch: { units?: UnitSystem; clock?: ClockFormat; locale?: string }) {
    chooseDisplay(patch);
    if (!user || user.demo) return;
    try {
      setUser(await updateSettings(patch));
    } catch {
      toast('Could not save that');
    }
  }

  return (
    <>
      <div className="lbl">Units & formats</div>
      <div className="card stack" style={{ gap: 12 }}>
        <Seg
          label="Units"
          value={d.units}
          onChange={(v) => void change({ units: v })}
          options={[
            { value: 'metric', label: 'Metric (km, kg)' },
            { value: 'imperial', label: 'Imperial (mi, lb)' },
          ]}
        />
        <Seg
          label="Clock"
          value={d.clock}
          onChange={(v) => void change({ clock: v })}
          options={[
            { value: '12h', label: '12-hour' },
            { value: '24h', label: '24-hour' },
          ]}
        />
        <label className="input">
          <select
            value={picked}
            onChange={(e) => void change({ locale: e.target.value })}
            aria-label="Number format"
          >
            {locales.map((l) => (
              <option key={l.locale} value={l.locale}>
                {l.example}
              </option>
            ))}
          </select>
          <span>Number format</span>
        </label>
        <small className="muted num" data-testid="display-preview">
          {formatDistanceKm(10.2, d)} · {formatWeightKg(82.5, d)} ·{' '}
          {formatTime(new Date(Date.UTC(2000, 0, 1, 19, 5)), d, 'UTC')} ·{' '}
          {formatNumber(12345.6, d, 1)}
        </small>
      </div>
    </>
  );
}
