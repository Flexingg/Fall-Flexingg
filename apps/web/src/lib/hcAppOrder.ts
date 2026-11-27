/**
 * The person's per-stat Health Connect app choice (HcAppOrder, see packages/shared/src/hcApps.ts)
 * as kept on the phone in direct mode (no Gauntlet server). In server mode it lives on the server
 * and comes through `hcApps()` in session.ts; the settings screen saves it with `saveHcAppOrder`
 * here (direct) or PUT /api/me/hc-apps (server).
 */
import { hcAppOrderSchema, type HcAppOrder } from '@gauntlet/shared';
import { storage } from './storage';

export const HC_APP_ORDER_KEY = 'gauntlet.direct.hcAppOrder';

/** The saved order; `{}` (no filter) when nothing is saved or what is saved can't be read. */
export async function loadHcAppOrder(): Promise<HcAppOrder> {
  try {
    const raw = await storage.get(HC_APP_ORDER_KEY);
    if (!raw) return {};
    const parsed = hcAppOrderSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Save the order (an empty object clears the choice). */
export async function saveHcAppOrder(order: HcAppOrder): Promise<void> {
  const clean = hcAppOrderSchema.parse(order);
  await storage.set(HC_APP_ORDER_KEY, Object.keys(clean).length ? JSON.stringify(clean) : null);
}
