/**
 * "Where did this number come from?" for one stat on one day: the stored value, the source that
 * counts and why (daily_metrics.source / detail), every source that reported it, and which Health
 * Connect apps wrote it on the phone (health_origins). Always the signed-in person's own rows.
 */
import {
  healthAppName,
  statMeta,
  type MetricDetail,
  type PhoneAppShare,
  type StatCandidate,
  type StatSourceResponse,
} from '@gauntlet/shared';
import { sourceKey, sourceLabel } from '@gauntlet/sparky';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { dailyMetrics, healthOrigins } from '../db/schema.js';

/** Fold the candidates by source (a source with two values keeps its highest), chosen one first. */
export function foldCandidates(
  detail: MetricDetail | null,
  chosenKey: string | null,
  value: number,
): StatCandidate[] {
  if (!detail) return [];
  const byKey = new Map<string, number>();
  for (const c of detail.candidates) {
    const k = sourceKey(c.source);
    byKey.set(k, Math.max(byKey.get(k) ?? -Infinity, c.value));
  }
  // A source that could not be matched by name (stored without one) is the one with the same value.
  const matchByValue =
    chosenKey == null || !byKey.has(chosenKey)
      ? ([...byKey].find(([, v]) => Math.abs(v - value) < 1e-9)?.[0] ?? null)
      : null;
  const out = [...byKey].map(([key, v]): StatCandidate => ({
    sourceKey: key,
    label: sourceLabel(key),
    value: v,
    chosen: detail.rule !== 'combined' && (key === chosenKey || key === matchByValue),
  }));
  return out.sort((a, b) => Number(b.chosen) - Number(a.chosen) || b.value - a.value);
}

export async function buildStatSource(
  ctx: AppContext,
  userId: string,
  date: string,
  metric: string,
): Promise<StatSourceResponse> {
  const meta = statMeta(metric)!;
  const [row] = await ctx.db
    .select()
    .from(dailyMetrics)
    .where(
      and(
        eq(dailyMetrics.userId, userId),
        eq(dailyMetrics.date, date),
        eq(dailyMetrics.metric, metric),
      ),
    );
  const [origin] = await ctx.db
    .select()
    .from(healthOrigins)
    .where(
      and(
        eq(healthOrigins.userId, userId),
        eq(healthOrigins.date, date),
        eq(healthOrigins.metric, metric),
      ),
    );

  const apps: PhoneAppShare[] = (origin?.apps ?? [])
    .map((a) => ({ ...a, name: healthAppName(a.packageName) }))
    .sort((a, b) => b.value - a.value);
  const chosenKey = row?.source ? sourceKey(row.source) : null;
  const detail = row?.detail ?? null;
  return {
    date,
    metric,
    ...meta,
    value: row?.value ?? null,
    source: row
      ? chosenKey
        ? { key: chosenKey, label: sourceLabel(chosenKey) }
        : { key: 'unknown', label: 'Unknown source' }
      : null,
    rule: row && detail ? detail.rule : null,
    ...(row && detail?.order ? { order: detail.order } : {}),
    candidates: row ? foldCandidates(detail, chosenKey, row.value) : [],
    phone: origin
      ? {
          apps,
          counted: origin.counted,
          capped: origin.capped,
          reportedAt: origin.updatedAt.toISOString(),
        }
      : null,
    overlap: apps.filter((a) => a.value > 0).length >= 2,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}
