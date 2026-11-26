/**
 * Shared contract for the server admin page and backups: what the overview reports, what a backup
 * file is called, and the job states the backup service writes.
 */
import { z } from 'zod';

/** A backup is one tar file with this name; the suffix says where it came from. */
export const BACKUP_NAME_RE = /^gauntlet-backup-\d{8}-\d{6}(-manual|-pre-restore|-uploaded)?\.tar$/;
export const BACKUP_JOB_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export type BackupKind = 'auto' | 'manual' | 'pre-restore' | 'uploaded';

export function backupKind(name: string): BackupKind {
  if (name.endsWith('-manual.tar')) return 'manual';
  if (name.endsWith('-pre-restore.tar')) return 'pre-restore';
  if (name.endsWith('-uploaded.tar')) return 'uploaded';
  return 'auto';
}

export interface BackupInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
  kind: BackupKind;
}

export interface BackupJob {
  id: string;
  action: 'backup' | 'restore';
  state: 'queued' | 'running' | 'done' | 'failed';
  message: string;
  file: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface BackupsResponse {
  /** False when the server has no backup folder (BACKUP_DIR) set. */
  configured: boolean;
  backups: BackupInfo[];
  current: BackupJob | null;
  last: { file: string; sizeBytes: number; createdAt: string } | null;
  /** From the backup service: when the next automatic backup runs. */
  nextAt: string | null;
  keep: number | null;
  /** Whether the backup service has checked in recently. */
  serviceRunning: boolean;
  /** What to run after a restore. */
  restartCommand: string;
}

export const restoreBodySchema = z.object({ confirm: z.literal('RESTORE') });

export interface DiskUsage {
  path: string;
  usedBytes: number;
  freeBytes: number | null;
  totalBytes: number | null;
}

export interface AdminOverview {
  version: string;
  uptimeSeconds: number;
  nodeVersion: string;
  counts: {
    users: number;
    demoUsers: number;
    activeChallenges: number;
    finishedChallenges: number;
    friendships: number;
  };
  sync: {
    lastCycle: { at: string; ok: number; failed: number } | null;
    lastUserSyncAt: string | null;
    problems: { userId: string; name: string; error: string; at: string | null }[];
    invalidKeys: { userId: string; name: string }[];
  };
  database: { gauntletBytes: number; sparkyBytes: number | null };
  storage: { downloads: DiskUsage | null; backups: DiskUsage | null };
  android: { version: string; builtAt: string; sizeBytes: number } | null;
  backups: {
    configured: boolean;
    count: number;
    last: { file: string; sizeBytes: number; createdAt: string } | null;
    serviceRunning: boolean;
    current: BackupJob | null;
  };
}
