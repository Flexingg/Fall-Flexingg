/**
 * How a stat is named and measured for the "where did this come from" sheet: the same label the day
 * screen uses, plus its stored unit and decimals. Shared so the server and the phone (direct mode)
 * agree, and so both validate the same metric keys.
 */
import { RING_LABELS } from './dayStats.js';
import { trendDef } from './derive.js';
import { HEALTH_METRICS, isHealthMetric } from './healthMetrics.js';

export interface StatMeta {
  label: string;
  unit: string;
  decimals: number;
}

/** Null when the key is not a stat Gauntlet stores (goals, junk). */
export function statMeta(metric: string): StatMeta | null {
  if (isHealthMetric(metric)) {
    const h = HEALTH_METRICS[metric];
    return { label: h.label, unit: h.unit, decimals: h.decimals };
  }
  const d = trendDef(metric);
  if (!d) return null;
  return {
    label: (RING_LABELS as Record<string, string>)[metric] ?? d.label,
    unit: d.unit,
    decimals: d.decimals,
  };
}
