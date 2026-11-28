import { App as CapApp } from '@capacitor/app';
import { useQueryClient } from '@tanstack/react-query';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { WidgetBridge } from './components/WidgetBridge';
import { AppBanner } from './components/AppBanner';
import { DisplaySync } from './components/DisplaySync';
import { PredictiveBack } from './components/PredictiveBack';
import { PullToRefresh } from './components/PullToRefresh';
import { Shortcuts } from './components/Shortcuts';
import { AutoRefresh } from './lib/freshness';
import { ConnectServer } from './components/ConnectServer';
import { LaunchSplash, shouldShowSplash } from './components/LaunchSplash';
import { ToastHost } from './components/ui';
import { useAuth } from './lib/auth';
import { useDisplay } from './lib/display';
import { syncHealthConnectIfDue } from './lib/health';
import { isNative } from './lib/platform';
import { useWallpaper } from './lib/queries';
import { publishWallpaper } from './lib/wallpaper';
import { BadgeCelebration } from './components/BadgeCelebration';
import { DayPage } from './pages/Day';
import { ChallengesPage } from './pages/Challenges';
import { FriendsPage } from './pages/Friends';
import { LoginPage } from './pages/Login';
import { SignupPage } from './pages/Signup';
import { TodayPage } from './pages/Today';
import { TrendsPage } from './pages/Trends';
import { LoadFailed, RoutePrefetch, lazyPage } from './components/lazyPage';

// Screens off the main tabs load on demand and are fetched quietly once the app is idle.
const AdminPage = lazyPage(() => import('./pages/Admin').then((m) => ({ default: m.AdminPage })), {
  admin: true,
});
const AdminBadgesPage = lazyPage(
  () => import('./pages/AdminBadges').then((m) => ({ default: m.AdminBadgesPage })),
  { admin: true },
);
const AdminChallengesPage = lazyPage(
  () => import('./pages/AdminChallenges').then((m) => ({ default: m.AdminChallengesPage })),
  { admin: true },
);
const AdminUserPage = lazyPage(
  () => import('./pages/AdminUser').then((m) => ({ default: m.AdminUserPage })),
  { admin: true },
);
const AdminUsersPage = lazyPage(
  () => import('./pages/AdminUsers').then((m) => ({ default: m.AdminUsersPage })),
  { admin: true },
);
const BadgesPage = lazyPage(() =>
  import('./pages/Badges').then((m) => ({ default: m.BadgesPage })),
);
const BadgeTimelinePage = lazyPage(() =>
  import('./pages/BadgeTimeline').then((m) => ({ default: m.BadgeTimelinePage })),
);
const EditRingsPage = lazyPage(() =>
  import('./pages/EditRings').then((m) => ({ default: m.EditRingsPage })),
);
const ChallengeDetailPage = lazyPage(() =>
  import('./pages/ChallengeDetail').then((m) => ({ default: m.ChallengeDetailPage })),
);
const FeedItemPage = lazyPage(() =>
  import('./pages/FeedItem').then((m) => ({ default: m.FeedItemPage })),
);
const JoinPage = lazyPage(() => import('./pages/Join').then((m) => ({ default: m.JoinPage })));
const MePage = lazyPage(() => import('./pages/Me').then((m) => ({ default: m.MePage })));
const NotificationSettingsPage = lazyPage(() =>
  import('./pages/NotificationSettings').then((m) => ({ default: m.NotificationSettingsPage })),
);
const NotificationsPage = lazyPage(() =>
  import('./pages/Notifications').then((m) => ({ default: m.NotificationsPage })),
);
const RecapPage = lazyPage(() => import('./pages/Recap').then((m) => ({ default: m.RecapPage })));
const ReviewPage = lazyPage(() =>
  import('./pages/Review').then((m) => ({ default: m.ReviewPage })),
);
const OAuthReturnPage = lazyPage(() =>
  import('./pages/OAuthReturn').then((m) => ({ default: m.OAuthReturnPage })),
);
const ProfilePage = lazyPage(() =>
  import('./pages/Profile').then((m) => ({ default: m.ProfilePage })),
);
const NewChallengePage = lazyPage(() =>
  import('./pages/NewChallenge').then((m) => ({ default: m.NewChallengePage })),
);
const ResultPage = lazyPage(() =>
  import('./pages/Result').then((m) => ({ default: m.ResultPage })),
);
const SourcesPage = lazyPage(() =>
  import('./pages/Sources').then((m) => ({ default: m.SourcesPage })),
);
const WallpaperPage = lazyPage(() =>
  import('./pages/Wallpaper').then((m) => ({ default: m.WallpaperPage })),
);
const WorkoutPage = lazyPage(() =>
  import('./pages/Workout').then((m) => ({ default: m.WorkoutPage })),
);
const PhoneAppsIndexPage = lazyPage(() =>
  import('./pages/PhoneApps').then((m) => ({ default: m.PhoneAppsIndexPage })),
);
const PhoneAppsPage = lazyPage(() =>
  import('./pages/PhoneApps').then((m) => ({ default: m.PhoneAppsPage })),
);

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
    // (Back is not handled here: PredictiveBack owns it, so Android can animate it.)
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
      syncHealthConnectIfDue()
        .then((sent) => (sent ? qc.invalidateQueries() : undefined))
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
  const { status, user } = useAuth();
  useDisplay(); // a change of units or clock re-renders every screen
  const [splash, setSplash] = useState(shouldShowSplash);
  return (
    <BrowserRouter>
      {splash && <LaunchSplash ready={status !== 'loading'} onDone={() => setSplash(false)} />}
      <div className="app">
        <NativeBridge />
        <PredictiveBack />
        <Shortcuts />
        <DisplaySync />
        <WidgetBridge />
        <AutoRefresh />
        <RoutePrefetch enabled={status === 'signedIn'} admin={!!user?.isAdmin} />
        {status === 'signedIn' && <PullToRefresh />}
        <AppBanner />
        <LoadFailed>
          <Suspense fallback={null}>
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
                path="/day"
                element={
                  <Private>
                    <DayPage />
                  </Private>
                }
              />
              <Route
                path="/day/rings"
                element={
                  <Private>
                    <EditRingsPage />
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
                path="/sources/phone-apps"
                element={
                  <Private>
                    <PhoneAppsIndexPage />
                  </Private>
                }
              />
              <Route
                path="/sources/phone-apps/:metric"
                element={
                  <Private>
                    <PhoneAppsPage />
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
          </Suspense>
        </LoadFailed>
        <BadgeCelebration hold={splash} />
        <ToastHost />
      </div>
    </BrowserRouter>
  );
}
