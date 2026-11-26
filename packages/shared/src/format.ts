/**
 * One set of rules for how numbers, units, dates and times are written, so the app, the weekly
 * recap and every notification agree. Everything is stored in metric (km, kg, L, 24-hour UTC
 * instants); these helpers only decide how a value reads for the person looking at it, following
 * their display settings: metric or imperial, 12 or 24-hour clock, and the number format (digit
 * grouping and decimal mark) of their locale. Pure functions, so the web app and the API share them.
 */

export type UnitSystem = 'metric' | 'imperial';
export type ClockFormat = '12h' | '24h';

export interface DisplayPrefs {
  units: UnitSystem;
  clock: ClockFormat;
  /** BCP 47 tag used for digit grouping, decimal marks, month names. */
  locale: string;
}

export const DEFAULT_DISPLAY: DisplayPrefs = { units: 'metric', clock: '12h', locale: 'en-US' };

/** Number formats offered in settings (the device's own locale is offered too). */
export const NUMBER_LOCALES: { locale: string; example: string }[] = [
  { locale: 'en-US', example: '1,234.5' },
  { locale: 'de-DE', example: '1.234,5' },
  { locale: 'fr-FR', example: '1 234,5' },
  { locale: 'en-IN', example: '12,34,567.5' },
];

export const KM_PER_MILE = 1.609344;
export const KG_PER_LB = 0.45359237;
/** US fluid ounce. */
export const L_PER_FLOZ = 0.0295735295625;
/** A US (short) ton is 2,000 pounds. */
const LB_PER_TON = 2000;

export const isUnitSystem = (v: unknown): v is UnitSystem => v === 'metric' || v === 'imperial';
export const isClockFormat = (v: unknown): v is ClockFormat => v === '12h' || v === '24h';

/** A usable locale tag, or the default when it is missing or not one Intl knows. */
export function normalizeLocale(locale: string | null | undefined): string {
  if (!locale) return DEFAULT_DISPLAY.locale;
  try {
    return Intl.NumberFormat.supportedLocalesOf([locale])[0] ?? DEFAULT_DISPLAY.locale;
  } catch {
    return DEFAULT_DISPLAY.locale;
  }
}

/** Countries that use miles and pounds day to day. */
const IMPERIAL_REGIONS = new Set(['US', 'LR', 'MM']);

/** Sensible starting settings for a device locale such as "en-US" or "de-DE". */
export function displayDefaultsFor(deviceLocale: string | null | undefined): DisplayPrefs {
  if (!deviceLocale) return DEFAULT_DISPLAY;
  const locale = normalizeLocale(deviceLocale);
  let region = '';
  let hour12: boolean | undefined;
  try {
    const l = new Intl.Locale(locale).maximize();
    region = l.region ?? '';
    const opts = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions();
    hour12 = opts.hour12;
  } catch {
    // fall through to defaults
  }
  return {
    units: IMPERIAL_REGIONS.has(region) ? 'imperial' : 'metric',
    clock: hour12 === false ? '24h' : '12h',
    locale,
  };
}

/** Fill in whatever a person has not chosen yet (null/undefined) from a base (the defaults). */
export function resolveDisplay(
  saved: { units?: unknown; clock?: unknown; locale?: unknown } | null | undefined,
  base: DisplayPrefs = DEFAULT_DISPLAY,
): DisplayPrefs {
  return {
    units: isUnitSystem(saved?.units) ? saved.units : base.units,
    clock: isClockFormat(saved?.clock) ? saved.clock : base.clock,
    locale:
      typeof saved?.locale === 'string' && saved.locale
        ? normalizeLocale(saved.locale)
        : base.locale,
  };
}

// ---------- Numbers ----------

const nfCache = new Map<string, Intl.NumberFormat>();
function nf(locale: string, min: number, max: number): Intl.NumberFormat {
  const key = `${locale}|${min}|${max}`;
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, { minimumFractionDigits: min, maximumFractionDigits: max });
    nfCache.set(key, f);
  }
  return f;
}

const usable = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

/**
 * A number with the locale's grouping, a fixed number of decimals ("–" for null/NaN). Negative
 * zero and values that round to zero lose their minus sign.
 */
export function formatNumber(
  value: number | null | undefined,
  prefs: Pick<DisplayPrefs, 'locale'> = DEFAULT_DISPLAY,
  decimals = 0,
): string {
  if (!usable(value)) return '–';
  const v = Number(value.toFixed(decimals));
  return nf(prefs.locale, decimals, decimals).format(Object.is(v, -0) ? 0 : v);
}

/** Up to `maxDecimals` decimals, none when the value is whole ("12", "12.5"). */
export function formatFlexible(
  value: number | null | undefined,
  prefs: Pick<DisplayPrefs, 'locale'> = DEFAULT_DISPLAY,
  maxDecimals = 1,
): string {
  if (!usable(value)) return '–';
  const v = Number(value.toFixed(maxDecimals));
  return nf(prefs.locale, 0, maxDecimals).format(Object.is(v, -0) ? 0 : v);
}

/** A whole number with grouping. */
export const formatInt = (
  value: number | null | undefined,
  prefs: Pick<DisplayPrefs, 'locale'> = DEFAULT_DISPLAY,
): string => formatNumber(value, prefs, 0);

/** Compact form for tight spots: 12,400 -> 12.4k. */
export function formatCompact(
  value: number,
  decimals = 1,
  prefs: Pick<DisplayPrefs, 'locale'> = DEFAULT_DISPLAY,
): string {
  if (!usable(value)) return '–';
  if (Math.abs(value) >= 1000) return `${formatFlexible(value / 1000, prefs, decimals)}k`;
  return formatFlexible(value, prefs, decimals);
}

/** "+12.4%" / "-3.0%": signed percent with one decimal. */
export function formatPercent(
  value: number | null | undefined,
  prefs: Pick<DisplayPrefs, 'locale'> = DEFAULT_DISPLAY,
  decimals = 1,
  signed = false,
): string {
  if (!usable(value)) return '–';
  const text = formatNumber(value, prefs, decimals);
  return `${signed && value > 0 ? '+' : ''}${text}%`;
}

// ---------- Units ----------

export interface Quantity {
  value: number;
  unit: string;
  /** Decimals that suit the unit after conversion. */
  decimals: number;
}

/**
 * A stored metric value in the person's units. Only units with an everyday imperial twin change:
 * km -> mi, kg -> lb, L -> fl oz. Anything else (steps, kcal, g, bpm, custom units) passes through.
 */
export function toDisplayUnit(
  value: number,
  unit: string,
  decimals: number,
  units: UnitSystem,
): Quantity {
  if (units === 'imperial') {
    if (unit === 'km') return { value: value / KM_PER_MILE, unit: 'mi', decimals };
    if (unit === 'kg') return { value: value / KG_PER_LB, unit: 'lb', decimals };
    if (unit === 'L')
      return { value: value / L_PER_FLOZ, unit: 'fl oz', decimals: Math.max(0, decimals - 1) };
  }
  return { value, unit, decimals };
}

/** The inverse of toDisplayUnit for what a person types: their unit's value back to stored metric. */
export function fromDisplayUnit(value: number, unit: string, units: UnitSystem): number {
  if (units === 'imperial') {
    if (unit === 'km') return value * KM_PER_MILE;
    if (unit === 'kg') return value * KG_PER_LB;
    if (unit === 'L') return value * L_PER_FLOZ;
  }
  return value;
}

/** The unit label a metric unit takes in the person's system ("km" -> "mi"). */
export const displayUnitLabel = (unit: string, units: UnitSystem): string =>
  toDisplayUnit(0, unit, 0, units).unit;

/**
 * A stored value with its unit, in the person's system: "10.2 km" or "6.3 mi". `decimals` are the
 * metric decimals (what the metric was defined with).
 */
export function formatQuantity(
  value: number | null | undefined,
  unit: string,
  decimals: number,
  prefs: Pick<DisplayPrefs, 'units' | 'locale'> = DEFAULT_DISPLAY,
  withUnit = true,
): string {
  if (!usable(value)) return '–';
  const q = toDisplayUnit(value, unit, decimals, prefs.units);
  const text = formatNumber(q.value, prefs, q.decimals);
  return withUnit && q.unit ? `${text} ${q.unit}` : text;
}

/** Like formatQuantity, but whole values drop their decimals ("5 km", "5.2 km"): for running text. */
export function formatQuantityFlexible(
  value: number | null | undefined,
  unit: string,
  maxDecimals: number,
  prefs: Pick<DisplayPrefs, 'units' | 'locale'> = DEFAULT_DISPLAY,
): string {
  if (!usable(value)) return '–';
  const q = toDisplayUnit(value, unit, maxDecimals, prefs.units);
  const text = formatFlexible(q.value, prefs, q.decimals);
  return q.unit ? `${text} ${q.unit}` : text;
}

type Fmt = Pick<DisplayPrefs, 'units' | 'locale'>;

/** Distance from kilometres: "6.3 mi". */
export const formatDistanceKm = (
  km: number | null | undefined,
  prefs: Fmt = DEFAULT_DISPLAY,
  decimals = 1,
) => formatQuantity(km, 'km', decimals, prefs);

/** Weight from kilograms: "82.5 kg" / "181.9 lb". */
export const formatWeightKg = (
  kg: number | null | undefined,
  prefs: Fmt = DEFAULT_DISPLAY,
  decimals = 1,
) => formatQuantity(kg, 'kg', decimals, prefs);

/** Liquid from litres: "2.5 L" / "85 fl oz". */
export const formatVolumeL = (
  l: number | null | undefined,
  prefs: Fmt = DEFAULT_DISPLAY,
  decimals = 1,
) => formatQuantity(l, 'L', decimals, prefs);

/**
 * Big lifting totals read better in tonnes: "12.4 t" (metric) or "13.7 tons" (imperial) from 10,000
 * kg up; below that plain kg / lb.
 */
export function formatLiftTotalKg(
  kg: number | null | undefined,
  prefs: Fmt = DEFAULT_DISPLAY,
): string {
  if (!usable(kg)) return '–';
  if (kg < 10_000) return formatWeightKg(kg, prefs, 0);
  if (prefs.units === 'imperial')
    return `${formatFlexible(kg / KG_PER_LB / LB_PER_TON, prefs, 1)} tons`;
  return `${formatFlexible(kg / 1000, prefs, 1)} t`;
}

/** Pace-style or other composite metrics can use this to attach a per-unit suffix: "min/km" -> "min/mi". */
export function displayRateUnit(unit: string, units: UnitSystem): string {
  if (units !== 'imperial') return unit;
  return unit.replace(/\/km$/, '/mi').replace(/\/kg$/, '/lb');
}

// ---------- Dates and times ----------

/** An ISO instant or Date as a Date, or null when it is not a valid time. */
function asDate(value: string | number | Date | null | undefined): Date | null {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const hour12 = (clock: ClockFormat) => clock === '12h';

/** Time of day: "7:05 PM" or "19:05" (always two digits in 24-hour). "–" when missing. */
export function formatTime(
  value: string | number | Date | null | undefined,
  prefs: Pick<DisplayPrefs, 'clock' | 'locale'> = DEFAULT_DISPLAY,
  timeZone?: string,
): string {
  const d = asDate(value);
  if (!d) return '–';
  return new Intl.DateTimeFormat(prefs.locale, {
    hour: prefs.clock === '24h' ? '2-digit' : 'numeric',
    minute: '2-digit',
    hour12: hour12(prefs.clock),
    hourCycle: prefs.clock === '24h' ? 'h23' : 'h12',
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}

/** A calendar day (YYYY-MM-DD) or instant as "Nov 10", "Nov 2026", "Mon, Nov 10"... */
export function formatDate(
  value: string | number | Date | null | undefined,
  prefs: Pick<DisplayPrefs, 'locale'> = DEFAULT_DISPLAY,
  options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' },
  timeZone?: string,
): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // A plain calendar day has no time zone: read it at noon UTC so no zone can shift it.
    const d = new Date(`${value}T12:00:00Z`);
    return new Intl.DateTimeFormat(prefs.locale, { ...options, timeZone: 'UTC' }).format(d);
  }
  const d = asDate(value);
  if (!d) return '–';
  return new Intl.DateTimeFormat(prefs.locale, {
    ...options,
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}

/** "Nov 10 – Nov 16", or one date when start and end are the same day. */
export function formatDateRange(
  start: string,
  end: string,
  prefs: Pick<DisplayPrefs, 'locale'> = DEFAULT_DISPLAY,
): string {
  const a = formatDate(start, prefs);
  return start === end ? a : `${a} – ${formatDate(end, prefs)}`;
}

/** "Nov 10, 7:05 PM" in the person's clock. */
export function formatDateTime(
  value: string | number | Date | null | undefined,
  prefs: Pick<DisplayPrefs, 'clock' | 'locale'> = DEFAULT_DISPLAY,
  timeZone?: string,
): string {
  const d = asDate(value);
  if (!d) return '–';
  return `${formatDate(d, prefs, { month: 'short', day: 'numeric' }, timeZone)}, ${formatTime(d, prefs, timeZone)}`;
}

/**
 * A wall-clock time as written ("07:37") in the person's clock, without any time-zone maths:
 * "7:37 AM" or "07:37". Anything that is not HH:MM gives "–".
 */
export function formatWallTime(
  hhmm: string | null | undefined,
  prefs: Pick<DisplayPrefs, 'clock' | 'locale'> = DEFAULT_DISPLAY,
): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? '');
  if (!m) return '–';
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return '–';
  return formatTime(new Date(Date.UTC(2000, 0, 1, h, min)), prefs, 'UTC');
}
