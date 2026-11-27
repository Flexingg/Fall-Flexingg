/**
 * The "which Health Connect apps count" chooser's data: the saved order and the apps seen writing
 * each stat. A server answers GET/PUT /api/me/hc-apps; direct mode (Android without a Gauntlet
 * server) keeps the order on the phone and works out the apps from the origins it stored.
 *
 * The direct-mode storage below is a stand-in for lib/hcAppOrder.ts (loadHcAppOrder/saveHcAppOrder),
 * which reads the same key; swap these two helpers for those when merging.
 */
import {
  addDays,
  summariseSeen,
  todayIn,
  type HcAppOrder,
  type HcAppsResponse,
} from '@gauntlet/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, put } from './api';
import { loadOrigins } from './hcOrigins';
import { timezone } from './platform';
import { session } from './session';
import { storage } from './storage';

export const HC_APP_ORDER_KEY = 'gauntlet.direct.hcAppOrder';
export const hcAppsKey = ['hc-apps'] as const;
const SEEN_DAYS = 30;

async function loadOrder(): Promise<HcAppOrder> {
  try {
    const raw = await storage.get(HC_APP_ORDER_KEY);
    return raw ? (JSON.parse(raw) as HcAppOrder) : {};
  } catch {
    return {};
  }
}

/** One list per stat, no repeats, nothing for an empty list (what the server stores too). */
export function cleanOrder(order: HcAppOrder): HcAppOrder {
  const out: HcAppOrder = {};
  for (const [metric, list] of Object.entries(order)) {
    const packages = [...new Set(list)];
    if (packages.length) out[metric] = packages;
  }
  return out;
}

async function directResponse(order: HcAppOrder): Promise<HcAppsResponse> {
  const since = addDays(todayIn(timezone), -SEEN_DAYS);
  const rows = (await loadOrigins()).filter((o) => o.date >= since);
  return { order, seen: summariseSeen(rows) };
}

async function fetchHcApps(): Promise<HcAppsResponse> {
  if (session.direct) return directResponse(await loadOrder());
  return get<HcAppsResponse>('/api/me/hc-apps');
}

export async function saveHcApps(order: HcAppOrder): Promise<HcAppsResponse> {
  if (!session.direct) return put<HcAppsResponse>('/api/me/hc-apps', { order });
  const clean = cleanOrder(order);
  await storage.set(HC_APP_ORDER_KEY, JSON.stringify(clean));
  return directResponse(clean);
}

export const useHcApps = () =>
  useQuery({
    queryKey: hcAppsKey,
    queryFn: () => fetchHcApps(),
    staleTime: 15_000,
  });

export function useSaveHcApps() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (order: HcAppOrder) => saveHcApps(order),
    onSuccess: (r) => qc.setQueryData(hcAppsKey, r),
  });
}
