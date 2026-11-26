import { describe, expect, it } from 'vitest';
import {
  displayDefaultsFor,
  formatCompact,
  formatDate,
  formatDateRange,
  formatDateTime,
  formatDistanceKm,
  formatFlexible,
  formatInt,
  formatLiftTotalKg,
  formatNumber,
  formatPercent,
  formatQuantity,
  formatQuantityFlexible,
  formatTime,
  formatVolumeL,
  formatWallTime,
  formatWeightKg,
  fromDisplayUnit,
  normalizeLocale,
  resolveDisplay,
  toDisplayUnit,
} from './format.js';
import { formatMetricValue } from './metrics.js';

const metric = { units: 'metric', locale: 'en-US' } as const;
const imperial = { units: 'imperial', locale: 'en-US' } as const;

describe('numbers', () => {
  it('groups digits by locale', () => {
    expect(formatInt(1234567, { locale: 'en-US' })).toBe('1,234,567');
    expect(formatInt(1234567, { locale: 'de-DE' })).toBe('1.234.567');
    expect(formatNumber(1234.5, { locale: 'de-DE' }, 1)).toBe('1.234,5');
    expect(formatNumber(1234567.5, { locale: 'en-IN' }, 1)).toBe('12,34,567.5');
  });
  it('handles zero, null and bad numbers', () => {
    expect(formatInt(0)).toBe('0');
    expect(formatNumber(0, undefined, 1)).toBe('0.0');
    expect(formatInt(null)).toBe('–');
    expect(formatInt(undefined)).toBe('–');
    expect(formatNumber(Number.NaN)).toBe('–');
    expect(formatNumber(Infinity)).toBe('–');
  });
  it('never prints a minus sign for values that round to zero', () => {
    expect(formatNumber(-0.04, undefined, 1)).toBe('0.0');
    expect(formatInt(-0.2)).toBe('0');
    expect(formatInt(-3)).toBe('-3');
  });
  it('flexible drops needless decimals', () => {
    expect(formatFlexible(12)).toBe('12');
    expect(formatFlexible(12.54)).toBe('12.5');
    expect(formatFlexible(12.04)).toBe('12');
    expect(formatFlexible(null)).toBe('–');
  });
  it('compacts thousands in the locale', () => {
    expect(formatCompact(12400)).toBe('12.4k');
    expect(formatCompact(12000)).toBe('12k');
    expect(formatCompact(950)).toBe('950');
    expect(formatCompact(12400, 1, { locale: 'de-DE' })).toBe('12,4k');
  });
  it('writes signed percents', () => {
    expect(formatPercent(12.44, undefined, 1, true)).toBe('+12.4%');
    expect(formatPercent(-3, undefined, 1, true)).toBe('-3.0%');
    expect(formatPercent(0, undefined, 0, true)).toBe('0%');
    expect(formatPercent(null)).toBe('–');
  });
});

describe('units', () => {
  it('converts distance, weight and liquid to imperial', () => {
    expect(formatDistanceKm(10, metric)).toBe('10.0 km');
    expect(formatDistanceKm(10, imperial)).toBe('6.2 mi');
    expect(formatDistanceKm(0, imperial)).toBe('0.0 mi');
    expect(formatWeightKg(82.5, metric)).toBe('82.5 kg');
    expect(formatWeightKg(82.5, imperial)).toBe('181.9 lb');
    expect(formatVolumeL(2.5, metric)).toBe('2.5 L');
    expect(formatVolumeL(2.5, imperial)).toBe('85 fl oz');
  });
  it('leaves other units alone', () => {
    expect(formatQuantity(1200, 'kcal', 0, imperial)).toBe('1,200 kcal');
    expect(formatQuantity(80, 'g', 0, imperial)).toBe('80 g');
    expect(formatQuantity(9000, '', 0, imperial)).toBe('9,000');
    expect(formatQuantity(null, 'km', 1, imperial)).toBe('–');
    expect(formatQuantity(3, 'km', 1, imperial, false)).toBe('1.9');
  });
  it('round-trips what people type', () => {
    expect(
      fromDisplayUnit(toDisplayUnit(12.3, 'km', 1, 'imperial').value, 'km', 'imperial'),
    ).toBeCloseTo(12.3, 9);
    expect(fromDisplayUnit(10, 'kg', 'imperial')).toBeCloseTo(4.5359, 3);
    expect(fromDisplayUnit(10, 'kg', 'metric')).toBe(10);
  });
  it('formats metric values for a viewer', () => {
    const def = { unit: 'km', decimals: 1 };
    expect(formatMetricValue(10.2, def)).toBe('10.2 km');
    expect(formatMetricValue(10.2, def, true, imperial)).toBe('6.3 mi');
    expect(formatMetricValue(10.2, def, false, imperial)).toBe('6.3');
    expect(formatMetricValue(null, def, true, imperial)).toBe('–');
  });
  it('words running text with flexible decimals', () => {
    expect(formatQuantityFlexible(5, 'km', 1, metric)).toBe('5 km');
    expect(formatQuantityFlexible(5, 'km', 1, imperial)).toBe('3.1 mi');
    expect(formatQuantityFlexible(2400, 'kg', 0, imperial)).toBe('5,291 lb');
  });
  it('shows big lifting totals in tonnes or tons', () => {
    expect(formatLiftTotalKg(8200, metric)).toBe('8,200 kg');
    expect(formatLiftTotalKg(12400, metric)).toBe('12.4 t');
    expect(formatLiftTotalKg(12400, imperial)).toBe('13.7 tons');
    expect(formatLiftTotalKg(null, imperial)).toBe('–');
  });
});

describe('time and dates', () => {
  const evening = new Date('2026-11-10T19:05:00Z');
  it('writes 12 and 24-hour clocks', () => {
    expect(formatTime(evening, { clock: '12h', locale: 'en-US' }, 'UTC')).toBe('7:05 PM');
    expect(formatTime(evening, { clock: '24h', locale: 'en-US' }, 'UTC')).toBe('19:05');
  });
  it('pads 24-hour mornings and handles midnight and noon', () => {
    const q = (iso: string, clock: '12h' | '24h') =>
      formatTime(iso, { clock, locale: 'en-US' }, 'UTC');
    expect(q('2026-11-10T07:05:00Z', '24h')).toBe('07:05');
    expect(q('2026-11-10T00:30:00Z', '24h')).toBe('00:30');
    expect(q('2026-11-10T00:30:00Z', '12h')).toBe('12:30 AM');
    expect(q('2026-11-10T12:00:00Z', '12h')).toBe('12:00 PM');
  });
  it('respects the time zone', () => {
    expect(formatTime(evening, { clock: '24h', locale: 'en-US' }, 'America/New_York')).toBe(
      '14:05',
    );
  });
  it('gives a dash for missing or invalid times', () => {
    expect(formatTime(null)).toBe('–');
    expect(formatTime('not a time')).toBe('–');
    expect(formatTime('')).toBe('–');
    expect(formatDateTime(undefined)).toBe('–');
  });
  it('formats wall-clock times without time zone maths', () => {
    expect(formatWallTime('07:37', { clock: '24h', locale: 'en-US' })).toBe('07:37');
    expect(formatWallTime('19:05:00', { clock: '12h', locale: 'en-US' })).toBe('7:05 PM');
    expect(formatWallTime('25:00')).toBe('–');
    expect(formatWallTime(null)).toBe('–');
  });
  it('formats calendar days and ranges', () => {
    expect(formatDate('2026-11-10')).toBe('Nov 10');
    expect(formatDate('2026-11-10', { locale: 'en-US' }, { month: 'short', year: 'numeric' })).toBe(
      'Nov 2026',
    );
    expect(formatDateRange('2026-11-10', '2026-11-16')).toBe('Nov 10 – Nov 16');
    expect(formatDateRange('2026-11-10', '2026-11-10')).toBe('Nov 10');
    expect(formatDate(null)).toBe('–');
  });
  it('writes a date with its time', () => {
    expect(formatDateTime(evening, { clock: '24h', locale: 'en-US' }, 'UTC')).toBe('Nov 10, 19:05');
    expect(formatDateTime(evening, { clock: '12h', locale: 'en-US' }, 'UTC')).toBe(
      'Nov 10, 7:05 PM',
    );
  });
});

describe('defaults', () => {
  it('guesses from the device locale', () => {
    expect(displayDefaultsFor('en-US')).toMatchObject({ units: 'imperial', clock: '12h' });
    expect(displayDefaultsFor('de-DE')).toMatchObject({ units: 'metric', clock: '24h' });
    expect(displayDefaultsFor(undefined)).toEqual({
      units: 'metric',
      clock: '12h',
      locale: 'en-US',
    });
  });
  it('fills in what is not chosen yet', () => {
    expect(resolveDisplay({ units: 'imperial' })).toEqual({
      units: 'imperial',
      clock: '12h',
      locale: 'en-US',
    });
    expect(resolveDisplay({ units: null, clock: 'bogus', locale: 'de-DE' })).toEqual({
      units: 'metric',
      clock: '12h',
      locale: 'de-DE',
    });
    expect(resolveDisplay(null)).toEqual({ units: 'metric', clock: '12h', locale: 'en-US' });
  });
  it('rejects locales Intl does not know', () => {
    expect(normalizeLocale('zz-not-real-123456')).toBe('en-US');
    expect(normalizeLocale(null)).toBe('en-US');
    expect(normalizeLocale('fr-FR')).toBe('fr-FR');
  });
});
