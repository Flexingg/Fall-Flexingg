/**
 * The "which Health Connect apps count" chooser's data: the saved order and the apps seen writing
 * each stat. A server answers GET/PUT /api/me/hc-apps; direct mode (Android without a Gauntlet
 * server) keeps the order on the phone and works out the apps from the origins it stored.
 *
 * Direct mode stores the order with lib/hcAppOrder.ts, the same place the phone's sync reads it.
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
import { loadHcAppOrder, saveHcAppOrder } from './hcAppOrder';
import { loadOrigins } from './hcOrigins';
import { timezone } from './platform';
import { session } from './session';

export const hcAppsKey = ['hc-apps'] as const;
const SEEN_DAYS = 30;

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
  if (session.direct) return directResponse(await loadHcAppOrder());
  return get<HcAppsResponse>('/api/me/hc-apps');
}

export async function saveHcApps(order: HcAppOrder): Promise<HcAppsResponse> {
  if (!session.direct) return put<HcAppsResponse>('/api/me/hc-apps', { order });
  const clean = cleanOrder(order);
  await saveHcAppOrder(clean);
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
