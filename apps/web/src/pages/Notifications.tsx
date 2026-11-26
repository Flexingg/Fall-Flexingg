import type { AppNotification, NotificationKind } from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { Icon, type IconName } from '../components/Icon';
import { Empty, ErrorBox, Header, Screen } from '../components/ui';
import { SkeletonList } from '../components/Skeleton';
import { post } from '../lib/api';
import { timeAgo } from '../lib/format';
import { notifyKeys, useNotifications, useUnreadCount } from '../lib/notifyQueries';
import '../styles/notify.css';

const ICONS: Record<NotificationKind, IconName> = {
  lead_change: 'trophy',
  challenge_invite: 'trophy',
  challenge_finished: 'trophy',
  friend_request: 'friends',
  nudge: 'pulse',
  reaction: 'flame',
  comment: 'user',
  personal_record: 'flame',
  weekly_recap: 'trends',
  new_round: 'refresh',
  month_review: 'trends',
};

export function NotificationsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const list = useNotifications();
  const unread = useUnreadCount();
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: notifyKeys.list });
    void qc.invalidateQueries({ queryKey: notifyKeys.unread });
  };

  async function open(n: AppNotification) {
    if (!n.read) await post(`/api/notifications/${n.id}/read`).catch(() => undefined);
    refresh();
    if (n.url) navigate(n.url);
  }

  async function markAll() {
    await post('/api/notifications/read-all').catch(() => undefined);
    refresh();
  }

  return (
    <Screen tabs={false}>
      <Header
        title="Notifications"
        back="/"
        action={
          <Link to="/me/notifications" className="bell-btn" aria-label="Notification settings">
            <Icon name="settings" size={22} />
          </Link>
        }
      />
      <ErrorBox error={list.error} />
      {!!unread.data?.count && (
        <div className="lbl">
          <span>{unread.data.count} unread</span>
          <button onClick={() => void markAll()}>Mark all read</button>
        </div>
      )}
      {list.isPending ? (
        <SkeletonList rows={5} avatar={36} />
      ) : items.length ? (
        <div className="list">
          {items.map((n) => (
            <button
              key={n.id}
              className={`item notif${n.read ? '' : ' unread'}`}
              onClick={() => void open(n)}
            >
              <span className="notif-icon">
                <Icon name={ICONS[n.kind] ?? 'bell'} size={18} />
              </span>
              <span className="grow">
                <span className="t">{n.title}</span>
                <small>{n.body}</small>
                <small className="notif-time">{timeAgo(n.createdAt)}</small>
              </span>
              {!n.read && <i className="notif-dot" aria-label="Unread" />}
            </button>
          ))}
        </div>
      ) : (
        <div className="list">
          <Empty title="Nothing yet">
            Friend requests, challenge updates and your weekly recap show up here.
          </Empty>
        </div>
      )}
      {list.hasNextPage && (
        <button
          className="btn secondary"
          style={{ marginTop: 12 }}
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? 'Loading…' : 'Show older'}
        </button>
      )}
    </Screen>
  );
}
