import { expect, test, type Page } from '@playwright/test';

const shots = process.env.SCREENSHOT_DIR;

async function snap(page: Page, name: string) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

async function signIn(page: Page, email = 'you@example.com') {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

test('walks every screen', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Gauntlet' })).toBeVisible();
  await snap(page, '00-login');

  await signIn(page);
  await expect(page.getByText('Weekend 100K', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('Connect your first data source')).toHaveCount(0);
  await snap(page, '01-today');

  await page.getByRole('link', { name: 'Challenges' }).click();
  await expect(page.getByText('Active Minutes Cup')).toBeVisible();
  await snap(page, '02-challenges');

  await page.getByText('Weekend 100K').click();
  await expect(page.getByLabel('Top three')).toBeVisible();
  await snap(page, '03-challenge');

  await page.goto('/c/new');
  await expect(page.getByRole('heading', { name: 'New challenge' })).toBeVisible();
  await snap(page, '04-new-challenge');

  await page.getByRole('link', { name: 'Friends' }).click();
  await expect(page.getByText('Maya Rodriguez')).toBeVisible();
  await snap(page, '05-friends');

  await page.getByRole('link', { name: 'Trends' }).click();
  await expect(page.getByText('Personal bests')).toBeVisible();
  await snap(page, '06-trends');

  await page.goto('/sources');
  await expect(page.getByText('Garmin Connect').first()).toBeVisible();
  await snap(page, '07-sources');

  await page.goto('/challenges');
  await page.getByRole('button', { name: 'Finished' }).click();
  await page.getByText('Step Wars').click();
  await expect(page.getByRole('button', { name: 'Rematch' })).toBeVisible();
  await snap(page, '08-result');
});

test('creates a challenge end to end', async ({ page }) => {
  await signIn(page);
  await page.goto('/c/new');
  await page.getByLabel('Challenge name').fill('Step Sprint');
  await page.getByRole('button', { name: 'Steps' }).click();
  await page.getByRole('button', { name: '3 days' }).click();
  await page.getByRole('button', { name: 'Invite Maya Rodriguez' }).click();
  await page.getByRole('button', { name: 'Start challenge' }).click();
  await expect(page.getByRole('heading', { name: 'Step Sprint' })).toBeVisible();
  await expect(page.getByText('Waiting on Maya')).toBeVisible();
});

// Needs the API started with DOWNLOADS_DIR pointing at a latest.json (CI does this).
test('offers the Android APK on the web', async ({ page }) => {
  test.skip(!process.env.E2E_APK, 'API is not hosting an APK');
  await signIn(page);
  await page.goto('/me');
  await expect(page.getByText('Gauntlet for Android')).toBeVisible();
  const link = page.getByRole('link', { name: 'Download APK' });
  await expect(link).toHaveAttribute('href', '/downloads/gauntlet-latest.apk');
  const res = await page.request.get('/downloads/gauntlet-latest.apk');
  expect(res.headers()['content-type']).toBe('application/vnd.android.package-archive');
  await snap(page, '09-profile-android');
});

test('creates an account from the sign-in screen', async ({ page }) => {
  test.skip(!!process.env.E2E_DIRECT, 'server build only');
  await page.goto('/login');
  await page.getByRole('link', { name: 'Create an account' }).click();
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await page.getByLabel('Name').fill('Riley Park');
  await page.getByLabel('Email').fill(`riley-${Date.now()}@example.com`);
  await page.getByLabel('Password').fill('short');
  await snap(page, '00b-signup');
  await page.getByLabel('Password').fill('riley-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
});

test('connects Garmin from the data sources screen', async ({ page }) => {
  test.skip(!!process.env.E2E_DIRECT, 'server build only');
  await signIn(page);
  await page.goto('/sources');
  await expect(page.getByRole('heading', { name: 'Data sources' })).toBeVisible();
  await page.getByRole('button', { name: /Garmin Connect.*Steps, workouts/ }).click();
  await page.getByLabel('Garmin email').fill('mfa@garmin.demo');
  await page.getByLabel('Garmin password').fill('wrong');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText("Garmin didn't accept that email and password.")).toBeVisible();
  await snap(page, '09-garmin-error');

  await page.getByLabel('Garmin password').fill('demo');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByLabel('Garmin code')).toBeVisible();
  await snap(page, '10-garmin-code');
  await page.getByLabel('Garmin code').fill('123456');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText(/^Connected/)).toBeVisible();
  await snap(page, '11-garmin-connected');

  await page.getByRole('button', { name: /Garmin Connect.*Connected/ }).click();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('button', { name: /Garmin Connect.*Steps, workouts/ })).toBeVisible();
});

test('connects Hevy with a key, and shows apps this server has no keys for', async ({ page }) => {
  test.skip(!!process.env.E2E_DIRECT, 'server build only');
  await signIn(page);
  await page.goto('/sources');
  await expect(page.getByRole('button', { name: /Oura Ring.*Not available/ })).toBeVisible();
  await page.getByRole('button', { name: /Hevy.*Gym workouts/ }).click();
  await page.getByLabel('Hevy API key').fill('wrong-key-123');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(
    page.getByText("Hevy didn't accept that API key. Check it and try again."),
  ).toBeVisible();
  await page.getByLabel('Hevy API key').fill('good-hevy-key');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('button', { name: /Hevy.*Connected/ })).toBeVisible();
  await snap(page, '12-apps-connected');

  await page.getByRole('button', { name: /Hevy.*Connected/ }).click();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('button', { name: /Hevy.*Gym workouts/ })).toBeVisible();
});

test('connects Strava: sign in on its page, come back with a code', async ({ page }) => {
  test.skip(!!process.env.E2E_DIRECT, 'server build only');
  // The provider's own site, which the test stands in for.
  await page.route('https://auth.strava.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Strava sign-in</h1>' }),
  );
  await signIn(page);
  await page.goto('/sources');
  await page.getByRole('button', { name: /Strava.*Runs, rides/ }).click();
  await page.getByRole('button', { name: /Continue to Strava/ }).click();
  await page.waitForURL('https://auth.strava.test/**');

  // SparkyFitness sends the person back to the app with a code; the same browser started it.
  await page.goto('/oauth/strava?code=good-code&state=abc');
  await expect(page.getByRole('heading', { name: 'Data sources' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Strava.*Connected/ })).toBeVisible();

  await page.getByRole('button', { name: /Strava.*Connected/ }).click();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('button', { name: /Strava.*Runs, rides/ })).toBeVisible();
});

test('asks before finishing a connection this browser did not start', async ({ page }) => {
  test.skip(!!process.env.E2E_DIRECT, 'server build only');
  await page.route('https://auth.fitbit.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Fitbit sign-in</h1>' }),
  );
  await signIn(page);
  await page.goto('/sources');
  await page.getByRole('button', { name: /Fitbit.*Steps, activity/ }).click();
  await page.getByRole('button', { name: /Continue to Fitbit/ }).click();
  await page.waitForURL('https://auth.fitbit.test/**');

  // A link that arrives in a browser that never started the connection must ask first.
  await page.goto('/sources');
  await page.evaluate(() => localStorage.removeItem('gauntlet.oauth.pending'));
  await page.goto('/oauth/fitbit?code=good-code');
  await expect(page.getByText('Finish connecting Fitbit?')).toBeVisible();
  await snap(page, '13-oauth-confirm');
  await page.getByRole('button', { name: 'Connect Fitbit' }).click();
  await expect(page.getByRole('button', { name: /Fitbit.*Connected/ })).toBeVisible();

  await page.getByRole('button', { name: /Fitbit.*Connected/ }).click();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('button', { name: /Fitbit.*Steps, activity/ })).toBeVisible();
});

test('goes public, joins a public challenge from Discover, and finds people by name', async ({
  page,
}) => {
  await signIn(page, 'casey@example.com');

  // Nothing feeds this new account yet, so Today points at data sources.
  await expect(page.getByText('Connect your first data source')).toBeVisible();
  await snap(page, '11-no-sources');
  await page.getByRole('link', { name: 'Garmin', exact: true }).click();
  await expect(page).toHaveURL(/\/sources#garmin$/);
  await expect(page.getByLabel('Garmin email')).toBeVisible();

  // Private by default: Discover shows the challenge but asks to go public first.
  await page.goto('/challenges');
  await page.getByRole('button', { name: 'Discover' }).click();
  await expect(page.getByText('October Step Open')).toBeVisible();
  await expect(page.getByText('Featured')).toBeVisible();
  await expect(page.getByText('Your profile is private.')).toBeVisible();
  await snap(page, '12-discover');

  // Search finds only public people.
  await page.goto('/friends');
  await page.getByRole('button', { name: 'Add friend' }).click();
  await page.getByLabel('Find people').fill('jordan');
  await expect(page.getByText('Nobody found')).toBeVisible();
  await page.getByLabel('Find people').fill('riley');
  const results = page.getByLabel('Search results');
  await expect(results.getByText('Riley Park')).toBeVisible();
  await expect(results.getByText('@riley')).toBeVisible();
  await results.getByRole('button', { name: 'Add' }).click();
  await expect(results.getByText('Requested')).toBeVisible();
  await snap(page, '13-people-search');

  // Go public on the profile screen.
  await page.goto('/me');
  const toggle = page.getByRole('switch', { name: 'Public profile' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.getByLabel('Handle').fill('@Casey_D');
  await page.getByLabel('Handle').blur();
  await expect(page.getByText('@casey_d ·')).toBeVisible();
  await snap(page, '14-public-profile');

  // Now join from Discover.
  await page.goto('/challenges');
  await page.getByRole('button', { name: 'Discover' }).click();
  await page.getByText('October Step Open').click();
  await expect(page.getByText('Open to everyone')).toBeVisible();
  await page.getByRole('button', { name: 'Join challenge' }).click();
  await expect(page.getByRole('button', { name: 'Leave challenge' })).toBeVisible();
  await expect(page.getByText('Riley P.')).toBeVisible();
  await snap(page, '15-joined-public');

  // Put things back so the test can run again.
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Leave challenge' }).click();
  await expect(page.getByRole('heading', { name: 'Challenges' })).toBeVisible();
  await page.goto('/friends');
  await page.getByRole('button', { name: /Requests/ }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.goto('/me');
  await page.getByLabel('Handle').fill('');
  await page.getByLabel('Handle').blur();
  await expect(page.getByText('@casey_d ·')).toHaveCount(0);
  await page.getByRole('switch', { name: 'Public profile' }).click();
  await expect(page.getByRole('switch', { name: 'Public profile' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
});

test('new metrics: bulk vs cut leaderboard, weight target, one-lift challenge, fasting timer', async ({
  page,
}) => {
  await signIn(page);

  // Bulking (Alex) and cutting (Maya) on one calorie-goal leaderboard.
  await page.goto('/challenges');
  await page.getByText('Dial It In').click();
  await expect(page.getByText('Calorie goal ·')).toBeVisible();
  await expect(page.getByText('Maya R.')).toBeVisible();
  await snap(page, '16-calorie-goal');

  // The fasting challenge puts a timer on Today.
  await page.getByRole('link', { name: 'Today' }).click();
  const fasting = page.getByLabel('Fasting');
  await expect(fasting.getByRole('button', { name: 'Start 16h' })).toBeVisible();
  await fasting.getByRole('button', { name: 'Start 16h' }).click();
  await expect(fasting.getByText(/Fasting · 0h 0\dm/)).toBeVisible();
  await snap(page, '17-fasting');
  await fasting.getByRole('button', { name: 'End fast' }).click();
  await expect(fasting.getByRole('button', { name: 'Start 18h' })).toBeVisible();

  // A weight challenge needs your own target before it can start.
  await page.goto('/c/new');
  await page
    .getByRole('group', { name: 'Body' })
    .getByRole('button', { name: 'Weight goal' })
    .click();
  await expect(page.getByText('Weights stay private')).toBeVisible();
  const start = page.getByRole('button', { name: 'Start challenge' });
  await expect(start).toBeDisabled();
  await page.getByRole('button', { name: 'Gain weight' }).click();
  await page.getByLabel('My target').fill('3');
  await page.getByRole('button', { name: 'kg', exact: true }).click();
  await snap(page, '18-weight-goal');
  await start.click();
  await expect(page.getByText('Your target: gain 3 kg')).toBeVisible();

  // One exercise from Liftosaur: pick Squat and race on the heaviest set.
  await page.goto('/c/new');
  await page
    .getByRole('group', { name: 'Strength' })
    .getByRole('button', { name: 'One exercise' })
    .click();
  await page.getByLabel('Exercise').selectOption('squat');
  await expect(page.getByPlaceholder('Squat Max')).toBeVisible();
  await snap(page, '19-one-lift');
  await page.getByRole('button', { name: 'Start challenge' }).click();
  await expect(page.getByRole('heading', { name: 'Squat Max' })).toBeVisible();
  await expect(page.getByText('Squat max · Best single day')).toBeVisible();
});
