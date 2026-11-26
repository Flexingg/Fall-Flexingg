/** Server admin data: the overview, the backup list, job progress, and the upload with progress. */
import type { AdminOverview, BackupJob, BackupsResponse } from '@gauntlet/shared';
import { useQuery } from '@tanstack/react-query';
import { ApiError, authHeader, get, getApiBase } from './api';
import { fmtDateTime, fmtNum } from './format';

export const adminKeys = {
  overview: ['admin', 'overview'] as const,
  backups: ['admin', 'backups'] as const,
  job: (id: string) => ['admin', 'job', id] as const,
};

export const useAdminOverview = () =>
  useQuery({
    queryKey: adminKeys.overview,
    queryFn: () => get<AdminOverview>('/api/admin/overview'),
    refetchInterval: 30_000,
  });

/** Polls faster while a backup or restore is running. */
export const useAdminBackups = (busy: boolean) =>
  useQuery({
    queryKey: adminKeys.backups,
    queryFn: () => get<BackupsResponse>('/api/admin/backups'),
    refetchInterval: busy ? 2_000 : 20_000,
  });

export const useBackupJob = (id: string | null) =>
  useQuery({
    queryKey: adminKeys.job(id ?? ''),
    enabled: !!id,
    queryFn: () => get<BackupJob>(`/api/admin/backups/jobs/${id}`),
    refetchInterval: (q) =>
      q.state.data && (q.state.data.state === 'done' || q.state.data.state === 'failed')
        ? false
        : 1_500,
  });

/** Send a backup file to the server, reporting progress (fetch cannot do upload progress). */
export async function uploadBackup(file: File, onProgress: (fraction: number) => void) {
  const auth = await authHeader();
  return new Promise<{ name: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${getApiBase()}/api/admin/backups/upload`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    for (const [k, v] of Object.entries(auth)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onerror = () => reject(new ApiError("Can't reach Gauntlet. Check your connection.", 0));
    xhr.onload = () => {
      let body: { error?: string; code?: string; name?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve({ name: body.name ?? '' });
      else
        reject(new ApiError(body.error ?? `Upload failed (${xhr.status})`, xhr.status, body.code));
    };
    xhr.send(file);
  });
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return 'unknown';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${fmtNum(v, v < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return 'never';
  return fmtDateTime(iso);
}
