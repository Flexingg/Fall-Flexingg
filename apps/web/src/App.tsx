import { App as CapApp } from '@capacitor/app';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { WidgetBridge } from './components/WidgetBridge';
import { AppBanner } from './components/AppBanner';
import { DisplaySync } from './components/DisplaySync';
import { PullToRefresh } from './components/PullToRefresh';
import { Shortcuts } from './components/Shortcuts';
import { AutoRefresh } from './lib/freshness';
import { ConnectServer } from './components/ConnectServer';
import { LaunchSplash, shouldShowSplash } from './components/LaunchSplash';
import { ToastHost } from './components/ui';
import { useAuth } from './lib/auth';
import { useDisplay } from './lib/display';
import { syncHealthConnect } from './lib/health';
import { isNative } from './lib/platform';
import { useWallpaper } from './lib/queries';
import { publishWallpaper } from './lib/wallpaper';
import { AdminPage } from './pages/Admin';
import { AdminBadgesPage } from './pages/AdminBadges';
import { AdminChallengesPage } from './pages/AdminChallenges';
import { AdminUserPage } from './pages/AdminUser';
import { AdminUsersPage } from './pages/AdminUsers';
import { BadgesPage } from './pages/Badges';
import { BadgeTimelinePage } from './pages/BadgeTimeline';
import { BadgeCelebration } from './components/BadgeCelebration';
import { ChallengeDetailPage } from './pages/ChallengeDetail';
import { ChallengesPage } from './pages/Challenges';
import { FeedItemPage } from './pages/FeedItem';
import { FriendsPage } from './pages/Friends';
import { JoinPage } from './pages/Join';
import { LoginPage } from './pages/Login';
import { MePage } from './pages/Me';
import { NotificationSettingsPage } from './pages/NotificationSettings';
import { NotificationsPage } from './pages/Notifications';
import { RecapPage } from './pages/Recap';
import { ReviewPage } from './pages/Review';
import { OAuthReturnPage } from './pages/OAuthReturn';
import { ProfilePage } from './pages/Profile';
import { NewChallengePage } from './pages/NewChallenge';
import { ResultPage } from './pages/Result';
import { SignupPage } from './pages/Signup';
import { SourcesPage } from './pages/Sources';
import { TodayPage } from './pages/Today';
import { TrendsPage } from './pages/Trends';
import { WallpaperPage } from './pages/Wallpaper';
import { WorkoutPage } from './pages/Workout';

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

/** Server admin pages: anyone else is sent home. */
function AdminOnly({ children }: { children: ReactNode }) {
  const { user, mode } = useAuth();
  if (!user) return <Splash />;
  return user.isAdmin && mode !== 'direct' ? children : <Navigate to="/" replace />;
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

/** Where a tapped notification may take the app (the Android job opens https://<server>/<path>). */
const NOTIFICATION_PATH =
  /^\/(c\/[\w-]+(\/result)?|friends|notifications|recap\/[\w-]+|review\/[\d-]+|u\/[\w-]+(\/badges(\/timeline)?)?|badges(\/timeline)?|trends|challenges)$/;

/** Android: open invite links in-app, and push Health Connect data when the app comes to the front. */
function NativeBridge() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { status, user } = useAuth();
  useEffect(() => {
    if (!isNative) return;
    const openNotification = (url: string) => {
      try {
        const path = new URL(url).pathname.replace(/\/+$/, '');
        if (NOTIFICATION_PATH.test(path)) navigate(path);
      } catch {
        // Not a link we understand.
      }
    };
    // The app was closed when a notification was tapped.
    CapApp.getLaunchUrl()
      .then((l) => l?.url && openNotification(l.url))
      .catch(() => undefined);
    const subs = [
      CapApp.addListener('appUrlOpen', ({ url }) => {
        openNotification(url);
        const m = /\/j\/([\w-]+)/.exec(url);
        if (m) navigate(`/j/${m[1]}`);
        // An app's sign-in page sent the person back: finish connecting it.
        const o = /\/oauth\/(\w+)(\?[^#]*)?/.exec(url);
        if (o) navigate(`/oauth/${o[1]}${o[2] ?? ''}`);
        // The home-screen widget's challenge line (gauntlet-widget://open/c/<id>).
        const w = /^gauntlet-widget:\/\/open\/c\/([\w-]+)/.exec(url);
        if (w) navigate(`/c/${w[1]}`);
      }),
      CapApp.addListener('backButton', ({ canGoBack }) =>
        canGoBack ? window.history.back() : CapApp.minimizeApp(),
      ),
    ];
    // Tapped the widget's challenge while the app was closed: the link it launched with.
    CapApp.getLaunchUrl()
      .then((r) => {
        const w = r?.url ? /^gauntlet-widget:\/\/open\/c\/([\w-]+)/.exec(r.url) : null;
        if (w) navigate(`/c/${w[1]}`);
      })
      .catch(() => undefined);
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
  useDisplay(); // a change of units or clock re-renders every screen
  const [splash, setSplash] = useState(shouldShowSplash);
  return (
    <BrowserRouter>
      {splash && <LaunchSplash ready={status !== 'loading'} onDone={() => setSplash(false)} />}
      <div className="app">
        <NativeBridge />
        <Shortcuts />
        <DisplaySync />
        <WidgetBridge />
        <AutoRefresh />
        {status === 'signedIn' && <PullToRefresh />}
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
            path="/feed/:eventId"
            element={
              <Private>
                <NeedsServer what="Activity">
                  <FeedItemPage />
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
            path="/u/:id"
            element={
              <Private>
                <NeedsServer what="Profiles">
                  <ProfilePage />
                </NeedsServer>
              </Private>
            }
          />
          <Route
            path="/badges/timeline"
            element={
              <Private>
                <NeedsServer what="Badges">
                  <BadgeTimelinePage />
                </NeedsServer>
              </Private>
            }
          />
          <Route
            path="/u/:id/badges/timeline"
            element={
              <Private>
                <NeedsServer what="Badges">
                  <BadgeTimelinePage />
                </NeedsServer>
              </Private>
            }
          />
          <Route
            path="/badges"
            element={
              <Private>
                <NeedsServer what="Badges">
                  <BadgesPage />
                </NeedsServer>
              </Private>
            }
          />
          <Route
            path="/u/:id/badges"
            element={
              <Private>
                <NeedsServer what="Badges">
                  <BadgesPage />
                </NeedsServer>
              </Private>
            }
          />
          <Route
            path="/workouts/:id"
            element={
              <Private>
                <NeedsServer what="Workout details">
                  <WorkoutPage />
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
            path="/notifications"
            element={
              <Private>
                <NeedsServer what="Notifications">
                  <NotificationsPage />
                </NeedsServer>
              </Private>
            }
          />
          <Route
            path="/me/notifications"
            element={
              <Private>
                <NeedsServer what="Notifications">
                  <NotificationSettingsPage />
                </NeedsServer>
              </Private>
            }
          />
          <Route
            path="/recap/:week"
            element={
              <Private>
                <NeedsServer what="Weekly recap">
                  <RecapPage />
                </NeedsServer>
              </Private>
            }
          />
          <Route
            path="/review/:period"
            element={
              <Private>
                <NeedsServer what="Year in review">
                  <ReviewPage />
                </NeedsServer>
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
          <Route
            path="/admin"
            element={
              <Private>
                <AdminOnly>
                  <AdminPage />
                </AdminOnly>
              </Private>
            }
          />
          <Route
            path="/admin/badges"
            element={
              <Private>
                <AdminOnly>
                  <AdminBadgesPage />
                </AdminOnly>
              </Private>
            }
          />
          <Route
            path="/admin/users"
            element={
              <Private>
                <AdminOnly>
                  <AdminUsersPage />
                </AdminOnly>
              </Private>
            }
          />
          <Route
            path="/admin/users/:id"
            element={
              <Private>
                <AdminOnly>
                  <AdminUserPage />
                </AdminOnly>
              </Private>
            }
          />
          <Route
            path="/admin/challenges"
            element={
              <Private>
                <AdminOnly>
                  <AdminChallengesPage />
                </AdminOnly>
              </Private>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <BadgeCelebration hold={splash} />
        <ToastHost />
      </div>
    </BrowserRouter>
  );
}
