import { App as CapApp } from '@capacitor/app';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { ToastHost } from './components/ui';
import { useAuth } from './lib/auth';
import { syncHealthConnect } from './lib/health';
import { isNative } from './lib/platform';
import { ChallengeDetailPage } from './pages/ChallengeDetail';
import { ChallengesPage } from './pages/Challenges';
import { FriendsPage } from './pages/Friends';
import { JoinPage } from './pages/Join';
import { LoginPage } from './pages/Login';
import { MePage } from './pages/Me';
import { NewChallengePage } from './pages/NewChallenge';
import { ResultPage } from './pages/Result';
import { SourcesPage } from './pages/Sources';
import { TodayPage } from './pages/Today';
import { TrendsPage } from './pages/Trends';

function Private({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Splash />;
  if (status === 'signedOut')
    return <Navigate to="/login" replace state={{ next: location.pathname }} />;
  return children;
}

function Splash() {
  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <img
        src="/icons/favicon.svg"
        width={72}
        height={72}
        alt="Gauntlet"
        style={{ borderRadius: 18 }}
      />
    </div>
  );
}

/** Android: open invite links in-app, and push Health Connect data when the app comes to the front. */
function NativeBridge() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { status, user } = useAuth();
  useEffect(() => {
    if (!isNative) return;
    const subs = [
      CapApp.addListener('appUrlOpen', ({ url }) => {
        const m = /\/j\/([\w-]+)/.exec(url);
        if (m) navigate(`/j/${m[1]}`);
      }),
      CapApp.addListener('backButton', ({ canGoBack }) =>
        canGoBack ? window.history.back() : CapApp.minimizeApp(),
      ),
    ];
    return () => subs.forEach((s) => s.then((h) => h.remove()));
  }, [navigate]);
  useEffect(() => {
    if (!isNative || status !== 'signedIn' || !user?.settings.healthConnectSync) return;
    const run = () =>
      syncHealthConnect()
        .then(() => qc.invalidateQueries())
        .catch(() => undefined);
    run();
    const sub = CapApp.addListener('resume', run);
    return () => {
      sub.then((h) => h.remove());
    };
  }, [status, user?.settings.healthConnectSync, qc]);
  return null;
}

export function App() {
  const { status } = useAuth();
  return (
    <BrowserRouter>
      <div className="app">
        <NativeBridge />
        <Routes>
          <Route
            path="/login"
            element={
              status === 'signedIn' ? (
                <Navigate to="/" replace />
              ) : status === 'loading' ? (
                <Splash />
              ) : (
                <LoginPage />
              )
            }
          />
          <Route path="/j/:code" element={<JoinPage />} />
          <Route
            path="/"
            element={
              <Private>
                <TodayPage />
              </Private>
            }
          />
          <Route
            path="/challenges"
            element={
              <Private>
                <ChallengesPage />
              </Private>
            }
          />
          <Route
            path="/c/new"
            element={
              <Private>
                <NewChallengePage />
              </Private>
            }
          />
          <Route
            path="/c/:id"
            element={
              <Private>
                <ChallengeDetailPage />
              </Private>
            }
          />
          <Route
            path="/c/:id/result"
            element={
              <Private>
                <ResultPage />
              </Private>
            }
          />
          <Route
            path="/friends"
            element={
              <Private>
                <FriendsPage />
              </Private>
            }
          />
          <Route
            path="/trends"
            element={
              <Private>
                <TrendsPage />
              </Private>
            }
          />
          <Route
            path="/sources"
            element={
              <Private>
                <SourcesPage />
              </Private>
            }
          />
          <Route
            path="/me"
            element={
              <Private>
                <MePage />
              </Private>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <ToastHost />
      </div>
    </BrowserRouter>
  );
}
