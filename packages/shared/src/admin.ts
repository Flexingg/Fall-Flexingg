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
  /** From the backup service: when the next automatic backup runs (null when they're off). */
  nextAt: string | null;
  keep: number | null;
  /** The schedule and retention in effect. */
  schedule: BackupSchedule;
  /** Whether the backup service has checked in recently. */
  serviceRunning: boolean;
  /** What to run after a restore. */
  restartCommand: string;
}

export const restoreBodySchema = z.object({ confirm: z.literal('RESTORE') });

/**
 * When automatic backups run and how long backups are kept. Set on the admin page (saved into the
 * backups folder, where the backup service reads it); BACKUP_* env vars are the defaults.
 */
export const BACKUP_FREQUENCIES = ['off', 'hourly', 'daily', 'weekly', 'monthly'] as const;
export const backupScheduleSchema = z.object({
  frequency: z.enum(BACKUP_FREQUENCIES),
  /** Local time "HH:MM" (hourly uses only the minutes). */
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 03:30'),
  /** Weekly: 0 = Sunday … 6 = Saturday. */
  weekday: z.number().int().min(0).max(6),
  /** Monthly: day 1–28 (every month has it). */
  dayOfMonth: z.number().int().min(1).max(28),
  /** How many automatic backups to keep (0 = no limit). */
  keepCount: z.number().int().min(0).max(1000),
  /**
   * Delete automatic, manual and pre-restore backups older than this many days (0 = never).
   * The newest backup is always kept, and uploaded backups are only deleted by hand.
   */
  keepDays: z.number().int().min(0).max(3650),
});
export type BackupSchedule = z.infer<typeof backupScheduleSchema>;

export const DEFAULT_BACKUP_SCHEDULE: BackupSchedule = {
  frequency: 'daily',
  time: '03:30',
  weekday: 0,
  dayOfMonth: 1,
  keepCount: 14,
  keepDays: 0,
};

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
