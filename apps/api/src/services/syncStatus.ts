/** What the last background sync cycle did, kept in memory for the admin page (resets on restart). */
export interface SyncCycleInfo {
  at: Date;
  ok: number;
  failed: number;
}

let last: SyncCycleInfo | null = null;

export function recordSyncCycle(info: SyncCycleInfo) {
  last = info;
}

export const lastSyncCycle = () => last;
