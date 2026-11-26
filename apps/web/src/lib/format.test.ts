import { beforeEach, describe, expect, it } from 'vitest';
import { applyAccountSettings } from './display';
import {
  dateRange,
  fmt,
  fmtDateTime,
  fmtInt,
  fmtQty,
  fmtSolo,
  fmtWallTime,
  unitLabel,
} from './format';

const km = { unit: 'km', decimals: 1 };

describe('format helpers follow the display settings', () => {
  beforeEach(() => applyAccountSettings({ units: 'metric', clock: '12h', locale: 'en-US' }));

  it('metric by default', () => {
    expect(fmt(10.2, km)).toBe('10.2 km');
    expect(fmtQty(82.5, 'kg', 1)).toBe('82.5 kg');
    expect(unitLabel('km')).toBe('km');
  });

  it('switches to imperial and back', () => {
    applyAccountSettings({ units: 'imperial', clock: '12h', locale: 'en-US' });
    expect(fmt(10.2, km)).toBe('6.3 mi');
    expect(fmt(10.2, km, false)).toBe('6.3');
    expect(fmtQty(82.5, 'kg', 1)).toBe('181.9 lb');
    expect(fmtQty(2.5, 'L', 1)).toBe('85 fl oz');
    expect(unitLabel('kg')).toBe('lb');
    expect(unitLabel('kcal')).toBe('kcal');
    applyAccountSettings({ units: 'metric', clock: '12h', locale: 'en-US' });
    expect(fmt(10.2, km)).toBe('10.2 km');
  });

  it('uses the locale for grouping', () => {
    applyAccountSettings({ units: 'metric', clock: '12h', locale: 'de-DE' });
    expect(fmtInt(1234567)).toBe('1.234.567');
    expect(fmt(1234.5, km)).toBe('1.234,5 km');
  });

  it('handles missing values', () => {
    expect(fmt(null, km)).toBe('–');
    expect(fmtInt(undefined)).toBe('–');
    expect(fmtQty(Number.NaN, 'km')).toBe('–');
    expect(fmtDateTime(null)).toBe('–');
  });

  it('writes the clock the person chose', () => {
    expect(fmtWallTime('19:05')).toBe('7:05 PM');
    applyAccountSettings({ units: 'metric', clock: '24h', locale: 'en-US' });
    expect(fmtWallTime('19:05')).toBe('19:05');
    expect(fmtWallTime('07:05')).toBe('07:05');
  });

  it('writes solo values, dates and ranges', () => {
    expect(fmtSolo(12.44, 'pct', km)).toBe('+12.4%');
    expect(fmtSolo(0, 'pct', km)).toBe('0.0%');
    expect(fmtSolo(1, 'days', km)).toBe('1 day');
    expect(fmtSolo(1234, 'days', km)).toBe('1,234 days');
    expect(dateRange('2026-11-10', '2026-11-16')).toBe('Nov 10 – Nov 16');
  });
});
