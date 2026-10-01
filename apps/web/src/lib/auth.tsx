import type { LoginRequest, LoginResponse, MeUser } from '@gauntlet/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  ApiError,
  get,
  login as apiLogin,
  logout as apiLogout,
  onSignedOut,
  refreshSession,
} from './api';

type Status = 'loading' | 'signedOut' | 'signedIn';

interface AuthValue {
  status: Status;
  user: MeUser | null;
  login: (req: LoginRequest) => Promise<LoginResponse>;
  verify: (ticket: string, code: string) => Promise<LoginResponse>;
  logout: () => Promise<void>;
  setUser: (u: MeUser) => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<MeUser | null>(null);
  const qc = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await refreshSession();
      if (!ok) return !cancelled && setStatus('signedOut');
      try {
        const me = await get<MeUser>('/api/me');
        if (!cancelled) {
          setUser(me);
          setStatus('signedIn');
        }
      } catch (err) {
        if (!cancelled)
          setStatus(err instanceof ApiError && err.status === 0 ? 'signedIn' : 'signedOut');
      }
    })();
    const off = onSignedOut(() => {
      setUser(null);
      setStatus('signedOut');
      qc.clear();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [qc]);

  const finish = useCallback((res: LoginResponse) => {
    if (res.status === 'ok') {
      setUser(res.user);
      setStatus('signedIn');
    }
    return res;
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      user,
      login: async (req) => finish(await apiLogin('/api/auth/login', req)),
      verify: async (ticket, code) =>
        finish(await apiLogin('/api/auth/login/2fa', { ticket, code })),
      logout: async () => {
        await apiLogout();
        qc.clear();
        setUser(null);
        setStatus('signedOut');
      },
      setUser,
    }),
    [status, user, finish, qc],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
