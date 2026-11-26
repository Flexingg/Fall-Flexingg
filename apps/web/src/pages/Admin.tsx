import type { BackupInfo, BackupJob, DiskUsage } from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { ErrorBox, Header, Screen, Skeleton, toast } from '../components/ui';
import {
  adminKeys,
  formatBytes,
  formatUptime,
  uploadBackup,
  useAdminBackups,
  useAdminOverview,
  useBackupJob,
  when,
} from '../lib/admin';
import { del, getApiBase, post } from '../lib/api';
import '../styles/admin.css';
import { BackupScheduleCard, describeSchedule } from '../components/BackupSchedule';

const KIND_LABEL: Record<BackupInfo['kind'], string> = {
  auto: 'Automatic',
  manual: 'Manual',
  'pre-restore': 'Safety copy',
  uploaded: 'Uploaded',
};

export function AdminPage() {
  const overview = useAdminOverview();
  const o = overview.data;
  return (
    <Screen tabs={false}>
      <Header title="Server admin" back="/me" />
      <ErrorBox error={overview.error} />
      {!o ? (
        <Skeleton height={120} />
      ) : (
        <>
          <div className="lbl">Health</div>
          <div className="adm-grid">
            <Stat label="Version" value={o.version} />
            <Stat label="Running for" value={formatUptime(o.uptimeSeconds)} />
            <Stat label="Node" value={o.nodeVersion} />
            <Stat
              label="People"
              value={String(o.counts.users)}
              sub={`+ ${o.counts.demoUsers} demo`}
            />
            <Stat label="Running challenges" value={String(o.counts.activeChallenges)} />
            <Stat label="Finished challenges" value={String(o.counts.finishedChallenges)} />
            <Stat label="Friendships" value={String(o.counts.friendships)} />
            <Stat
              label="Android app"
              value={o.android ? o.android.version : 'none'}
              sub={o.android ? `${formatBytes(o.android.sizeBytes)}` : 'no build published'}
            />
          </div>

          <div className="lbl">Sync problems</div>
          <div className="card stack" style={{ gap: 8 }}>
            <small className="muted">
              {o.sync.lastCycle
                ? `Last background sync: ${when(o.sync.lastCycle.at)} (${o.sync.lastCycle.ok} worked, ${o.sync.lastCycle.failed} failed)`
                : 'No background sync has run since the server started.'}
              {o.sync.lastUserSyncAt ? ` Newest data pulled: ${when(o.sync.lastUserSyncAt)}.` : ''}
            </small>
            {o.sync.problems.length === 0 && o.sync.invalidKeys.length === 0 && (
              <div className="adm-ok">Everyone is syncing fine.</div>
            )}
            {o.sync.problems.map((p) => (
              <div key={p.userId} className="adm-problem">
                <b>{p.name}</b>
                <span>{p.error}</span>
                <small className="muted">{when(p.at)}</small>
              </div>
            ))}
            {o.sync.invalidKeys.map((k) => (
              <div key={k.userId} className="adm-problem">
                <b>{k.name}</b>
                <span>Lost access to SparkyFitness. They need to sign in again.</span>
              </div>
            ))}
          </div>

          <div className="lbl">Storage</div>
          <div className="list">
            <Row label="Gauntlet database" value={formatBytes(o.database.gauntletBytes)} />
            {o.database.sparkyBytes != null && (
              <Row label="SparkyFitness database" value={formatBytes(o.database.sparkyBytes)} />
            )}
            <DiskRow label="Android downloads" disk={o.storage.downloads} />
            <DiskRow label="Backups" disk={o.storage.backups} />
          </div>

          <div className="lbl">Backups</div>
          <BackupsSection />
        </>
      )}
    </Screen>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card adm-stat">
      <small className="muted">{label}</small>
      <b>{value}</b>
      {sub && <small className="muted">{sub}</small>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="item">
      <div className="grow t">{label}</div>
      <span className="muted">{value}</span>
    </div>
  );
}

function DiskRow({ label, disk }: { label: string; disk: DiskUsage | null }) {
  if (!disk) return <Row label={label} value="not set up" />;
  return (
    <Row
      label={label}
      value={`${formatBytes(disk.usedBytes)} used${disk.freeBytes != null ? `, ${formatBytes(disk.freeBytes)} free` : ''}`}
    />
  );
}

function BackupsSection() {
  const qc = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useBackupJob(jobId);
  const running = (j?: BackupJob | null) => !!j && (j.state === 'queued' || j.state === 'running');
  const list = useAdminBackups(running(job.data));
  const [error, setError] = useState<unknown>(null);
  const [restoring, setRestoring] = useState<BackupInfo | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const data = list.data;

  // Show whatever job is going on, even one someone else (or a scheduled run) started.
  const active = running(job.data) ? job.data! : (data?.current ?? null);
  const finished = job.data && !running(job.data) ? job.data : null;
  const refresh = () => qc.invalidateQueries({ queryKey: adminKeys.backups });

  if (list.isLoading || !data) return <Skeleton height={100} />;
  if (!data.configured) return <NotSetUp />;

  async function backUp() {
    setError(null);
    try {
      const j = await post<BackupJob>('/api/admin/backups');
      setJobId(j.id);
      refresh();
    } catch (err) {
      setError(err);
    }
  }

  async function download(b: BackupInfo) {
    setError(null);
    try {
      const { url } = await post<{ url: string }>(`/api/admin/backups/${b.name}/download-token`);
      // A plain link: the browser downloads it with its own progress bar.
      const a = document.createElement('a');
      a.href = `${getApiBase()}${url}`;
      a.download = b.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      setError(err);
    }
  }

  async function remove(b: BackupInfo) {
    if (!confirm(`Delete ${b.name}? This cannot be undone.`)) return;
    setError(null);
    try {
      await del(`/api/admin/backups/${b.name}`);
      toast('Backup deleted');
      refresh();
    } catch (err) {
      setError(err);
    }
  }

  async function upload(file: File) {
    setError(null);
    setProgress(0);
    try {
      await uploadBackup(file, setProgress);
      toast('Backup uploaded');
      refresh();
    } catch (err) {
      setError(err);
    } finally {
      setProgress(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const busy = !!active || progress !== null;
  return (
    <div className="stack" style={{ gap: 10 }}>
      <ErrorBox error={error} />
      {!data.serviceRunning && (
        <div className="error" role="alert">
          The backup service is not responding, so nothing is being backed up. Check that the{' '}
          <code>backup</code> container is running.
        </div>
      )}
      <div className="card stack" style={{ gap: 6 }}>
        <div className="row">
          <div className="grow">
            <div style={{ fontWeight: 700 }}>
              {data.last ? `Last backup: ${when(data.last.createdAt)}` : 'No backup yet'}
            </div>
            <small className="muted">
              {data.last ? `${formatBytes(data.last.sizeBytes)} · ` : ''}
              {data.nextAt
                ? `next automatic backup ${when(data.nextAt)}`
                : data.schedule.frequency === 'off'
                  ? 'automatic backups are off'
                  : 'next backup time unknown'}
            </small>
            <small className="muted" style={{ display: 'block' }}>
              {describeSchedule(data.schedule)}
            </small>
          </div>
        </div>
        {active && (
          <div className="adm-progress" role="status">
            <span className="adm-spin" aria-hidden="true" />
            {active.action === 'restore' ? 'Restoring' : 'Backing up'}: {active.message}
          </div>
        )}
        {finished && (
          <div className={finished.state === 'failed' ? 'error' : 'adm-ok'} role="status">
            {finished.state === 'failed' ? 'Failed: ' : ''}
            {finished.message}
            {finished.action === 'restore' && finished.state === 'done' && (
              <RestartNote command={data.restartCommand} />
            )}
          </div>
        )}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={backUp} disabled={busy || !data.serviceRunning}>
            Back up now
          </button>
          <button
            className="btn secondary sm"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
          >
            Upload a backup
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".tar,application/x-tar"
            hidden
            aria-label="Backup file"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
        </div>
        {progress !== null && (
          <div className="adm-bar" role="progressbar" aria-valuenow={Math.round(progress * 100)}>
            <i style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
      </div>

      <BackupScheduleCard schedule={data.schedule} />

      {data.backups.length === 0 ? (
        <small className="muted">Backups will be listed here.</small>
      ) : (
        <div className="list">
          {data.backups.map((b) => (
            <div key={b.name} className="item adm-backup">
              <div className="grow">
                <div className="t">{when(b.createdAt)}</div>
                <small className="muted">
                  {KIND_LABEL[b.kind]} · {formatBytes(b.sizeBytes)}
                </small>
              </div>
              <button className="btn secondary sm" onClick={() => download(b)}>
                Download
              </button>
              <button className="btn secondary sm" onClick={() => setRestoring(b)} disabled={busy}>
                Restore
              </button>
              <button
                className="btn danger sm"
                onClick={() => remove(b)}
                disabled={active?.file === b.name}
                aria-label={`Delete backup from ${when(b.createdAt)}`}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
      {restoring && (
        <RestoreDialog
          backup={restoring}
          command={data.restartCommand}
          onClose={() => setRestoring(null)}
          onStarted={(j) => {
            setRestoring(null);
            setJobId(j.id);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function RestartNote({ command }: { command: string }) {
  return (
    <div style={{ marginTop: 8 }}>
      Now restart the stack on the server, because SparkyFitness keeps data in memory:
      <pre className="adm-code">{command}</pre>
    </div>
  );
}

function RestoreDialog({
  backup,
  command,
  onClose,
  onStarted,
}: {
  backup: BackupInfo;
  command: string;
  onClose: () => void;
  onStarted: (j: BackupJob) => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [sending, setSending] = useState(false);
  async function go() {
    setSending(true);
    setError(null);
    try {
      onStarted(
        await post<BackupJob>(`/api/admin/backups/${backup.name}/restore`, { confirm: 'RESTORE' }),
      );
    } catch (err) {
      setError(err);
      setSending(false);
    }
  }
  return (
    <div className="adm-overlay" role="dialog" aria-modal="true" aria-label="Restore a backup">
      <div className="card stack adm-dialog" style={{ gap: 10 }}>
        <h2 style={{ margin: 0 }}>Restore this backup?</h2>
        <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>
          Backup from <b>{when(backup.createdAt)}</b> ({formatBytes(backup.sizeBytes)}).
        </p>
        <ul className="adm-steps">
          <li>A safety copy of everything as it is now is saved first.</li>
          <li>
            <b>All current data is replaced</b> with what is in the backup: accounts, challenges,
            SparkyFitness data and uploads. Anything added since is lost (except in the safety
            copy).
          </li>
          <li>
            Afterwards you must restart the stack on the server: <code>{command}</code>
          </li>
        </ul>
        <ErrorBox error={error} />
        <label className="input">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Type RESTORE to confirm"
            autoCapitalize="characters"
            autoComplete="off"
          />
          <span>Type RESTORE to confirm</span>
        </label>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger" onClick={go} disabled={text !== 'RESTORE' || sending}>
            Restore
          </button>
        </div>
      </div>
    </div>
  );
}

function NotSetUp() {
  return (
    <div className="card stack" style={{ gap: 8 }}>
      <b>Backups are not set up on this server.</b>
      <small className="muted" style={{ lineHeight: 1.5 }}>
        Gauntlet backs up through a small extra service in the Docker setup. To turn it on:
      </small>
      <ol className="adm-steps">
        <li>
          Use the latest <code>deploy/docker-compose.yml</code>: it has a <code>backup</code>{' '}
          service and a <code>backups</code> volume that Gauntlet shares (
          <code>BACKUP_DIR=/backups</code>).
        </li>
        <li>
          Optionally set <code>BACKUP_TIME</code> and <code>BACKUP_KEEP</code> in{' '}
          <code>deploy/.env</code>.
        </li>
        <li>
          Run{' '}
          <code>
            docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
          </code>
          .
        </li>
      </ol>
    </div>
  );
}
