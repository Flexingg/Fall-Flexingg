import { App as CapApp } from '@capacitor/app';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { AppBanner } from './components/AppBanner';
import { ConnectServer } from './components/ConnectServer';
import { LaunchSplash, shouldShowSplash } from './components/LaunchSplash';
import { ToastHost } from './components/ui';
import { useAuth } from './lib/auth';
import { syncHealthConnect } from './lib/health';
import { isNative } from './lib/platform';
import { useWallpaper } from './lib/queries';
import { publishWallpaper } from './lib/wallpaper';
import { ChallengeDetailPage } from './pages/ChallengeDetail';
import { ChallengesPage } from './pages/Challenges';
import { FriendsPage } from './pages/Friends';
import { JoinPage } from './pages/Join';
import { LoginPage } from './pages/Login';
import { MePage } from './pages/Me';
import { OAuthReturnPage } from './pages/OAuthReturn';
import { NewChallengePage } from './pages/NewChallenge';
import { ResultPage } from './pages/Result';
import { SignupPage } from './pages/Signup';
import { SourcesPage } from './pages/Sources';
import { TodayPage } from './pages/Today';
import { TrendsPage } from './pages/Trends';
import { WallpaperPage } from './pages/Wallpaper';

function Private({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Splash />;
  if (status === 'signedOut')
    return <Navigate to="/login" replace state={{ next: location.pathname + location.search }} />;
  return children;
}

/** Friends, challenges and invites live on a Gauntlet server; in direct mode offer to connect one. */
function NeedsServer({ what, children }: { what: string; children: ReactNode }) {
  const { mode } = useAuth();
  return mode === 'direct' ? <ConnectServer what={what} /> : children;
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
        // An app's sign-in page sent the person back: finish connecting it.
        const o = /\/oauth\/(\w+)(\?[^#]*)?/.exec(url);
        if (o) navigate(`/oauth/${o[1]}${o[2] ?? ''}`);
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
  // Keep the live wallpaper's copy of today's numbers current while the app is open.
  const wallpaper = useWallpaper(isNative && status === 'signedIn');
  useEffect(() => {
    if (wallpaper.data) publishWallpaper(wallpaper.data).catch(() => undefined);
  }, [wallpaper.data]);
  return null;
}

export function App() {
  const { status } = useAuth();
  const [splash, setSplash] = useState(shouldShowSplash);
  return (
    <BrowserRouter>
      {splash && <LaunchSplash ready={status !== 'loading'} onDone={() => setSplash(false)} />}
      <div className="app">
        <NativeBridge />
        <AppBanner />
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
          <Route
            path="/login/advanced"
            element={
              status === 'signedIn' ? (
                <Navigate to="/" replace />
              ) : status === 'loading' ? (
                <Splash />
              ) : (
                <LoginPage advanced />
              )
            }
          />
          <Route
            path="/signup"
            element={
              status === 'signedIn' ? (
                <Navigate to="/" replace />
              ) : status === 'loading' ? (
                <Splash />
              ) : (
                <SignupPage />
              )
            }
          />
          <Route
            path="/j/:code"
            element={
              <NeedsServer what="Invite">
                <JoinPage />
              </NeedsServer>
            }
          />
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
                <NeedsServer what="Challenges">
                  <ChallengesPage />
                </NeedsServer>
              </Private>
            }
          />
          <Route
            path="/c/new"
            element={
              <Private>
                <NeedsServer what="New challenge">
                  <NewChallengePage />
                </NeedsServer>
              </Private>
            }
          />
          <Route
            path="/c/:id"
            element={
              <Private>
                <NeedsServer what="Challenge">
                  <ChallengeDetailPage />
                </NeedsServer>
              </Private>
            }
          />
          <Route
            path="/c/:id/result"
            element={
              <Private>
                <NeedsServer what="Result">
                  <ResultPage />
                </NeedsServer>
              </Private>
            }
          />
          <Route
            path="/friends"
            element={
              <Private>
                <NeedsServer what="Friends">
                  <FriendsPage />
                </NeedsServer>
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
            path="/oauth/:provider"
            element={
              <Private>
                <NeedsServer what="Connect app">
                  <OAuthReturnPage />
                </NeedsServer>
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
          <Route
            path="/me/wallpaper"
            element={
              <Private>
                <WallpaperPage />
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
