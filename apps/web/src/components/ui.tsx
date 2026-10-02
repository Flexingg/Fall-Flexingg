import type { PublicUser } from '@gauntlet/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { Icon } from './Icon';

export function Avatar({
  user,
  size = 40,
  me,
  lead,
}: {
  user: Pick<PublicUser, 'initials'>;
  size?: number;
  me?: boolean;
  lead?: boolean;
}) {
  return (
    <span
      className={`av${me ? ' me' : ''}${lead ? ' lead' : ''}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.32) }}
      aria-hidden="true"
    >
      {user.initials}
    </span>
  );
}

export function TabBar() {
  const tabs = [
    { to: '/', label: 'Today', icon: 'today' as const, end: true },
    { to: '/challenges', label: 'Challenges', icon: 'trophy' as const },
    { to: '/friends', label: 'Friends', icon: 'friends' as const },
    { to: '/trends', label: 'Trends', icon: 'trends' as const },
  ];
  return (
    <nav className="tabbar" aria-label="Main">
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) => (isActive ? 'active' : '')}
        >
          <Icon name={t.icon} />
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}

export function Screen({ children, tabs = true }: { children: ReactNode; tabs?: boolean }) {
  return (
    <>
      <main className={`screen${tabs ? '' : ' no-tabs'}`}>
        <DemoBanner />
        {children}
      </main>
      {tabs && <TabBar />}
    </>
  );
}

export function Header({
  title,
  back,
  action,
}: {
  title: ReactNode;
  back?: string | true;
  action?: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <>
      {back && (
        <button className="back" onClick={() => (back === true ? navigate(-1) : navigate(back))}>
          <Icon name="back" size={16} /> Back
        </button>
      )}
      <div className="hd">
        <h1>{title}</h1>
        {action}
      </div>
    </>
  );
}

export function Seg<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="toggle"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const msg =
    error instanceof ApiError || error instanceof Error ? error.message : 'Something went wrong';
  const reconnect = (error as { code?: string }).code === 'sparky_key_invalid';
  return (
    <div className="error" role="alert">
      {msg}
      {reconnect && (
        <>
          {' '}
          <Link to="/me" style={{ textDecoration: 'underline' }}>
            Reconnect
          </Link>
        </>
      )}
    </div>
  );
}

export function Skeleton({ height = 60, style }: { height?: number; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height, ...style }} aria-hidden="true" />;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children}
    </div>
  );
}

let toastSetter: ((msg: string | null) => void) | null = null;
export function toast(msg: string) {
  toastSetter?.(msg);
}
export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    toastSetter = setMsg;
    return () => {
      toastSetter = null;
    };
  }, []);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 2600);
    return () => clearTimeout(t);
  }, [msg]);
  return msg ? (
    <div className="toast" role="status">
      {msg}
    </div>
  ) : null;
}

/** Shown where someone is about to compete without anything feeding their score. */
export function NoSourcesNote() {
  return (
    <div className="notice" style={{ marginBottom: 12 }}>
      Nothing is sending you data yet, so your score stays at 0.{' '}
      <Link to="/sources">Connect a data source</Link> first.
    </div>
  );
}

/** Said wherever someone is about to join a challenge that shows the workouts behind scores. */
export function ShowEventsNotice() {
  return (
    <small className="muted" style={{ lineHeight: 1.45 }}>
      Show Events is on: the workouts that count toward your score are visible to the other
      participants. Turn this off any time under Data sources → Privacy.
    </small>
  );
}

/** Shown on every screen while signed in as the built-in demo account. */
function DemoBanner() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  if (!user?.demo) return null;
  return (
    <div className="card" style={{ marginBottom: 12, padding: '10px 14px', fontSize: 13 }}>
      <strong>Demo account.</strong> Sample data that resets every day, so you can look around.{' '}
      <button
        className="linkish"
        style={{ color: 'var(--volt)', textDecoration: 'underline' }}
        onClick={async () => {
          await logout();
          navigate('/signup');
        }}
      >
        Create your own account
      </button>
    </div>
  );
}
