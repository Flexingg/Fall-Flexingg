import type { LoginRequest, LoginResponse, MeUser, SignupRequest } from '@gauntlet/shared';
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
  getApiBase,
  login as apiLogin,
  logout as apiLogout,
  onSignedOut,
  refreshSession,
  setApiBase,
} from './api';
import { DirectError } from './direct/DirectBackend';
import { secret } from './direct/secret';
import { stopNativePushOnSignOut } from './push';
import { DEFAULT_SERVER_URL, DIRECT_AVAILABLE, isNative } from './platform';
import {
  cleanUrl,
  clearStored,
  loadStored,
  makeDirect,
  saveStored,
  session,
  type Mode,
} from './session';
import { storage } from './storage';

type Status = 'loading' | 'signedOut' | 'signedIn';

export interface DirectLogin {
  sparkyUrl: string;
  apiKey: string;
  /** Optional Gauntlet server. Left empty, the app talks to SparkyFitness only. */
  serverUrl?: string;
}

interface AuthValue {
  status: Status;
  user: MeUser | null;
  /** How the app is talking right now. Null while signed out. */
  mode: Mode | null;
  /** Why the last automatic sign-in failed (for example the key was revoked). */
  notice: string | null;
  login: (req: LoginRequest) => Promise<LoginResponse>;
  verify: (ticket: string, code: string) => Promise<LoginResponse>;
  /** Create a SparkyFitness account through the Gauntlet server and sign in. */
  signup: (req: SignupRequest) => Promise<LoginResponse>;
  /** Sign in as the built-in demo account (sample data, no SparkyFitness needed). */
  loginDemo: () => Promise<LoginResponse>;
  loginDirect: (input: DirectLogin) => Promise<void>;
  /** Direct mode only: sign in at a Gauntlet server with the key already on the phone. */
  connectServer: (serverUrl: string) => Promise<void>;
  /** Back to direct mode; the key stays on the phone. */
  disconnectServer: () => Promise<void>;
  logout: () => Promise<void>;
  setUser: (u: MeUser) => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<MeUser | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const qc = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    const done = (s: Status, u: MeUser | null = null, m: Mode | null = null) => {
      if (cancelled) return;
      setUser(u);
      setMode(m);
      setStatus(s);
    };

    (async () => {
      const stored = DIRECT_AVAILABLE ? await loadStored() : null;
      // Installs from before direct mode have a refresh token but no saved mode.
      const legacyServer = isNative && !stored?.mode && !!(await storage.get('gauntlet.refresh'));

      if (stored?.mode === 'direct' && stored.sparkyUrl) {
        const key = await secret.get();
        if (!key) return done('signedOut');
        const backend = makeDirect(stored.sparkyUrl, key);
        try {
          const me = await backend.me();
          session.direct = backend;
          return done('signedIn', me, 'direct');
        } catch (err) {
          if (err instanceof DirectError && err.code === 'sparky_key_invalid') {
            await clearStored();
            if (!cancelled) setNotice(err.message);
          } else if (!cancelled) {
            setNotice(err instanceof Error ? err.message : null);
          }
          return done('signedOut');
        }
      }

      if (stored?.mode === 'server' || legacyServer) {
        setApiBase(stored?.serverUrl || DEFAULT_SERVER_URL);
        if (!stored?.mode) await saveStored({ mode: 'server', serverUrl: getApiBase() });
      }

      if (!(await refreshSession())) return done('signedOut');
      try {
        done('signedIn', await get<MeUser>('/api/me'), 'server');
      } catch (err) {
        if (err instanceof ApiError && err.status === 0) done('signedIn', null, 'server');
        else done('signedOut');
      }
    })();

    const off = onSignedOut(() => {
      setUser(null);
      setMode(null);
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
      setMode('server');
      setStatus('signedIn');
      setNotice(null);
    }
    return res;
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      user,
      mode,
      notice,
      login: async (req) => {
        const res = await apiLogin('/api/auth/login', req);
        if (res.status === 'ok' && DIRECT_AVAILABLE)
          await saveStored({ mode: 'server', serverUrl: getApiBase() });
        return finish(res);
      },
      loginDemo: async () => finish(await apiLogin('/api/auth/demo', {})),
      signup: async (req) => {
        const res = await apiLogin('/api/auth/signup', req);
        if (res.status === 'ok' && DIRECT_AVAILABLE)
          await saveStored({ mode: 'server', serverUrl: getApiBase() });
        return finish(res);
      },
      verify: async (ticket, code) => {
        const res = await apiLogin('/api/auth/login/2fa', { ticket, code });
        if (res.status === 'ok' && DIRECT_AVAILABLE)
          await saveStored({ mode: 'server', serverUrl: getApiBase() });
        return finish(res);
      },

      loginDirect: async ({ sparkyUrl, apiKey, serverUrl }) => {
        const url = cleanUrl(sparkyUrl);
        const key = apiKey.trim();
        const backend = makeDirect(url, key);
        await backend.check(); // throws DirectError with a specific reason
        qc.clear();
        if (serverUrl?.trim()) {
          // Full app: the Gauntlet server signs in with the same key.
          const server = cleanUrl(serverUrl);
          const before = getApiBase();
          setApiBase(server);
          let res: LoginResponse;
          try {
            res = await apiLogin('/api/auth/login', { method: 'api_key', apiKey: key });
          } catch (err) {
            setApiBase(before);
            throw err;
          }
          await secret.set(key);
          await saveStored({ mode: 'server', sparkyUrl: url, serverUrl: server });
          finish(res);
          return;
        }
        await secret.set(key);
        await saveStored({ mode: 'direct', sparkyUrl: url, serverUrl: null });
        session.direct = backend;
        setUser(await backend.me());
        setMode('direct');
        setStatus('signedIn');
        setNotice(null);
      },

      connectServer: async (serverUrl) => {
        const key = await secret.get();
        if (!key) throw new Error('The SparkyFitness key is missing. Sign out and sign in again.');
        const server = cleanUrl(serverUrl);
        const before = getApiBase();
        setApiBase(server);
        let res: LoginResponse;
        try {
          res = await apiLogin('/api/auth/login', { method: 'api_key', apiKey: key });
        } catch (err) {
          setApiBase(before);
          throw err;
        }
        qc.clear();
        session.direct = null;
        await saveStored({ mode: 'server', serverUrl: server });
        finish(res);
      },

      disconnectServer: async () => {
        const stored = await loadStored();
        const key = await secret.get();
        if (!stored.sparkyUrl || !key)
          throw new Error('No SparkyFitness key on this phone. Sign out and sign in again.');
        await apiLogout();
        const backend = makeDirect(stored.sparkyUrl, key);
        qc.clear();
        session.direct = backend;
        await saveStored({ mode: 'direct', serverUrl: null });
        setUser(await backend.me());
        setMode('direct');
      },

      logout: async () => {
        await stopNativePushOnSignOut();
        if (mode === 'server') await apiLogout();
        if (DIRECT_AVAILABLE) await clearStored();
        qc.clear();
        setUser(null);
        setMode(null);
        setStatus('signedOut');
      },
      setUser,
    }),
    [status, user, mode, notice, finish, qc],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
