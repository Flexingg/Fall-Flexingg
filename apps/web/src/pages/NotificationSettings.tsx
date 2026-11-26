import type { NotificationKind, NotificationPrefsResponse } from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ErrorBox, Header, Screen, toast, Toggle } from '../components/ui';
import { put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { notifyKeys, useNotificationPrefs, usePushConfig } from '../lib/notifyQueries';
import {
  disableNativePush,
  disableWebPush,
  enableNativePush,
  enableWebPush,
  hasNativePush,
  nativePushStatus,
  webPushBlocked,
  webPushSubscribed,
  webPushSupported,
} from '../lib/push';
import '../styles/notify.css';

/** The device-level switch: phone notifications in the Android app, browser notifications on the web. */
function PushControl() {
  const config = usePushConfig();
  const { user } = useAuth();
  const [on, setOn] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    const read = hasNativePush
      ? nativePushStatus().then((s) => ({ on: s.enabled, blocked: s.blocked }))
      : webPushSubscribed().then((v) => ({ on: v, blocked: webPushBlocked() }));
    read
      .then((s) => {
        if (!live) return;
        setOn(s.on);
        setBlocked(s.blocked);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  async function change(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (hasNativePush) {
        if (next) {
          const ok = await enableNativePush();
          setBlocked(!ok);
          setOn(ok);
        } else {
          await disableNativePush();
          setOn(false);
        }
      } else if (next) {
        const key = config.data?.webPush?.publicKey;
        if (!key) return;
        const ok = await enableWebPush(key);
        setBlocked(!ok);
        setOn(ok);
        if (ok) toast('Browser notifications are on');
      } else {
        await disableWebPush();
        setOn(false);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (user?.demo) return null;

  if (hasNativePush)
    return (
      <PushCard
        title="Phone notifications"
        on={on}
        busy={busy}
        onChange={change}
        error={error}
        note={
          blocked
            ? 'Notifications are blocked for Gauntlet. Allow them in your phone’s app settings, then try again.'
            : 'Gauntlet checks for news every 15 minutes or so, even when the app is closed. No Google services involved.'
        }
      />
    );

  if (!webPushSupported)
    return (
      <PushCard
        title="Browser notifications"
        unavailable
        note="This browser can’t show notifications from Gauntlet. On an iPhone, add Gauntlet to your home screen first."
      />
    );

  if (config.isSuccess && !config.data.webPush)
    return (
      <PushCard
        title="Browser notifications"
        unavailable
        note="Push isn’t set up on this server yet. The person who runs it can turn it on (see VAPID_PUBLIC_KEY in the README). Your list below still works."
      />
    );

  return (
    <PushCard
      title="Browser notifications"
      on={on}
      busy={busy || !config.isSuccess}
      onChange={change}
      error={error}
      note={
        blocked
          ? 'Notifications are blocked for this site. Allow them in your browser’s site settings, then try again.'
          : 'Get alerts on this device even when Gauntlet isn’t open.'
      }
    />
  );
}

function PushCard({
  title,
  note,
  on = false,
  busy,
  unavailable,
  onChange,
  error,
}: {
  title: string;
  note: string;
  on?: boolean;
  busy?: boolean;
  unavailable?: boolean;
  onChange?: (v: boolean) => void;
  error?: unknown;
}) {
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="row">
        <div className="grow t" style={{ fontWeight: 700 }}>
          {title}
        </div>
        {!unavailable && (
          <Toggle checked={on} onChange={(v) => onChange?.(v)} label={title} disabled={busy} />
        )}
      </div>
      <p className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
        {note}
      </p>
      <ErrorBox error={error} />
    </div>
  );
}

export function NotificationSettingsPage() {
  const qc = useQueryClient();
  const prefs = useNotificationPrefs();
  const [error, setError] = useState<unknown>(null);

  async function set(kind: NotificationKind, enabled: boolean) {
    setError(null);
    // Show the change straight away; the server's answer replaces it.
    qc.setQueryData<NotificationPrefsResponse>(
      notifyKeys.prefs,
      (old) => old && { kinds: old.kinds.map((k) => (k.kind === kind ? { ...k, enabled } : k)) },
    );
    try {
      qc.setQueryData(
        notifyKeys.prefs,
        await put<NotificationPrefsResponse>('/api/me/notification-prefs', {
          prefs: { [kind]: enabled },
        }),
      );
    } catch (err) {
      setError(err);
      void qc.invalidateQueries({ queryKey: notifyKeys.prefs });
    }
  }

  return (
    <Screen tabs={false}>
      <Header title="Notifications" back="/me" />
      <PushControl />
      <div className="lbl">Tell me about</div>
      <ErrorBox error={error ?? prefs.error} />
      <div className="list">
        {prefs.data?.kinds.map((k) => (
          <div key={k.kind} className="item" style={{ minHeight: 56 }}>
            <span className="grow t">{k.label}</span>
            <Toggle checked={k.enabled} onChange={(v) => void set(k.kind, v)} label={k.label} />
          </div>
        ))}
      </div>
    </Screen>
  );
}
