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

// When a test fails, keep a picture and the on-screen error text: CI only uploads the screenshots folder.
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  const errors = await page
    .locator('.error')
    .allTextContents()
    .catch(() => []);
  console.log(
    `FAILED: ${info.title}\n  url: ${page.url()}\n  on-screen errors: ${JSON.stringify(errors)}`,
  );
  if (shots)
    await page
      .screenshot({ path: `${shots}/FAIL-${info.title.replace(/\W+/g, '-').slice(0, 50)}.png` })
      .catch(() => undefined);
});

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
  await expect(page.locator('.item .t', { hasText: 'Riley P.' })).toBeVisible();
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
  await expect(page.locator('.item .t', { hasText: 'Maya R.' })).toBeVisible();
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

test('picks custom dates in the past, then edits visibility but not dates', async ({ page }) => {
  await signIn(page, 'riley@example.com');
  const stamp = Date.now().toString(36); // so the test can run again on the same data
  await page.goto('/c/new');
  await page.getByLabel('Challenge name').fill(`Back-dated ${stamp}`);
  await page
    .getByRole('group', { name: 'Activity' })
    .getByRole('button', { name: 'Steps' })
    .click();
  await page.getByLabel('Duration').getByRole('button', { name: 'Custom' }).click();
  const iso = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel('Start date').fill(iso(-12));
  await page.getByLabel('End date').fill(iso(4));
  await expect(page.getByText(/17 days · started 12 days ago/)).toBeVisible();
  await page.getByLabel('End date').fill(iso(-14));
  await expect(page.getByText('The end date is before the start date.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start challenge' })).toBeDisabled();
  await page.getByLabel('End date').fill(iso(4));
  await snap(page, '20-custom-dates');
  await page.getByRole('button', { name: 'Start challenge' }).click();
  await expect(page.getByRole('heading', { name: `Back-dated ${stamp}` })).toBeVisible();

  // Edit: rename, make it public; dates are read-only.
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByLabel('Edit challenge');
  await expect(edit.getByText(/Dates \(.*\) are fixed/)).toBeVisible();
  await edit.getByLabel('Challenge name').fill(`Open ${stamp}`);
  await edit.getByRole('switch', { name: 'Public challenge' }).click();
  await edit.getByRole('switch', { name: 'Show events' }).click();
  await snap(page, '21-edit-challenge');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: `Open ${stamp}` })).toBeVisible();
  await expect(page.getByText(/· Public/)).toBeVisible();

  // It is now listed in Discover.
  await page.goto('/challenges');
  await page.getByRole('button', { name: 'Discover' }).click();
  await expect(page.getByText(`Open ${stamp}`)).toBeVisible();

  // Clean up so the test can run again: back to private... and delete is only for upcoming ones,
  // so leave this challenge; it is renamed every run.
});

test('challenge page graphs everyone day by day', async ({ page }) => {
  await signIn(page);
  await page.goto('/challenges');
  await page.getByText('Weekend 100K').click();
  const chart = page.getByRole('img', { name: /^Progress by day\./ });
  await expect(chart).toBeVisible();
  await expect(chart).toHaveAttribute('aria-label', /You [\d.]+ km/);
  // Legend names everyone, and the table view has a row per day.
  await expect(page.getByText('Maya R.').first()).toBeVisible();
  await page.getByText('Table', { exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Maya R.' })).toBeVisible();
  await expect(page.getByRole('row').nth(1)).toBeVisible();
  await chart.scrollIntoViewIfNeeded();
  await snap(page, '22a-progress-resting');
  // Tapping a day shows every person's value for it.
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await expect(page.getByRole('status')).toContainText('You');
  await snap(page, '22-progress-graph');
});

test('Show Events lists the workouts that counted, and respects opt-outs', async ({ page }) => {
  await signIn(page);
  await page.goto('/challenges');
  await page.getByText('Weekend 100K').click();
  const section = page.getByLabel('What counted');
  await expect(section).toBeVisible();
  // Yesterday had real runs for Alex and Maya; Dre keeps his workouts private.
  await section.getByRole('button', { name: 'Previous day' }).click();
  await expect(section.getByText('Running').first()).toBeVisible();
  await expect(section.getByText(/\d+ min · \d+ kcal/).first()).toBeVisible();
  await expect(section.getByText('Keeps workouts private')).toBeVisible();
  await snap(page, '23-what-counted');
  // One person at a time.
  await section.getByRole('button', { name: 'Maya', exact: true }).click();
  await expect(section.getByText('Maya R.')).toBeVisible();
  await expect(section.getByText('Dre T.')).toHaveCount(0);
  // A challenge without Show Events has no such section.
  await page.goto('/challenges');
  await page.getByText('Active Minutes Cup').click();
  await expect(page.getByLabel('What counted')).toHaveCount(0);
});

test('Trends covers every stat, not just the built-in activity ones', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Trends' }).click();
  const metric = page.getByLabel('Metric');
  // Groups mirror the new-challenge picker, with each exercise, weight and custom measurements.
  for (const label of ['Strength', 'Nutrition', 'Body', 'Fasting', 'Custom'])
    await expect(metric.locator(`optgroup[label="${label}"]`)).toHaveCount(1);
  await expect(metric.locator('option', { hasText: 'Squat heaviest set' })).toHaveCount(1);
  await expect(metric.locator('option', { hasText: 'Squat est. 1RM' })).toHaveCount(1);
  await expect(metric.locator('option', { hasText: 'Calorie goal' })).toHaveCount(1);
  await expect(metric.locator('option', { hasText: /^Weight/ })).toHaveCount(1);
  await expect(metric.locator('option', { hasText: /^Mood/ })).toHaveCount(1);

  // The overview lists every stat with data; tapping one charts it.
  const all = page.getByLabel('All stats');
  await expect(all.getByText('Squat heaviest set')).toBeVisible();
  await expect(all.getByText('Mood')).toBeVisible();
  await expect(all.getByText('Calorie goal')).toBeVisible();
  await snap(page, '24-trends-overview');
  await all.getByRole('button', { name: /Mood/ }).click();
  await expect(page.getByRole('listbox', { name: 'Mood per day' })).toBeVisible();
  await metric.selectOption('weight');
  await expect(page.getByText(/kg latest/).first()).toBeVisible();
  await metric.selectOption('lift_max:squat');
  await expect(page.getByText(/kg best/).first()).toBeVisible();
  await snap(page, '25-trends-lift');
});

test('plays the launch splash, then hands off to the app', async ({ page }) => {
  await page.goto('/login?splash=1');
  const splash = page.getByRole('img', { name: /^Gauntlet\. Throw it down/ });
  await expect(splash).toBeVisible();
  await page.waitForTimeout(900);
  await snap(page, '30-splash-early');
  await page.waitForTimeout(700);
  await snap(page, '31-splash-landed');
  // It gets out of the way by itself, and the sign-in screen is there underneath.
  await expect(splash).toHaveCount(0, { timeout: 8000 });
  await expect(page.getByRole('heading', { name: 'Gauntlet' })).toBeVisible();
  // Played once per app start: no splash again in this page session.
  await page.getByRole('link', { name: 'Create an account' }).click();
  await expect(splash).toHaveCount(0);
});

test('solo challenges: pace against a goal, and beating your past self', async ({ page }) => {
  await signIn(page);
  // Seeded: a total to reach and a comparison with the previous week.
  await page.goto('/challenges');
  await expect(page.getByText('Solo').first()).toBeVisible();
  await page.getByText('Run 80 km').click();
  const card = page.getByLabel('Your progress');
  await expect(card).toBeVisible();
  await expect(card.getByText(/of 80\.0 km/)).toBeVisible();
  await expect(card.getByText(/Even pace/)).toBeVisible();
  await expect(page.getByRole('img', { name: /^Progress by day\./ })).toBeVisible();
  await expect(page.getByText(/Goal 80/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Invite friends/ })).toHaveCount(0);
  await snap(page, '40-solo-target');

  await page.goto('/challenges');
  await page.getByText('Beat last week').click();
  await expect(page.getByLabel('Your progress').getByText(/Change vs before/)).toBeVisible();
  await expect(
    page.getByLabel('Your progress').getByText(/Compared with your steps over the 7 days before/),
  ).toBeVisible();
  await snap(page, '41-solo-improve');

  // Create one: against yourself, a daily average.
  const stamp = Date.now().toString(36);
  await page.goto('/c/new');
  await page.getByRole('button', { name: 'Solo' }).click();
  await expect(page.getByText('Who can join')).toHaveCount(0);
  await expect(page.getByText('Invite', { exact: true })).toHaveCount(0);
  await page.getByLabel('Challenge name').fill(`Steady ${stamp}`);
  await page
    .getByRole('group', { name: 'Activity' })
    .getByRole('button', { name: 'Steps' })
    .click();
  await page
    .getByRole('group', { name: 'Goal type' })
    .getByRole('button', { name: 'Daily average' })
    .click();
  await expect(page.getByRole('button', { name: 'Start solo challenge' })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Goal' }).fill('9000');
  await snap(page, '42-new-solo');
  await page.getByRole('button', { name: 'Start solo challenge' }).click();
  await page.waitForURL(/\/c\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: `Steady ${stamp}` })).toBeVisible();
  await expect(page.getByLabel('Your progress').getByText(/a day/).first()).toBeVisible();
  // Delete it again so the demo stays tidy.
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Delete this solo challenge' }).click();
  await expect(page.getByRole('heading', { name: 'Challenges' })).toBeVisible();
});

test('the demo account: one tap in, sample data, nothing that needs SparkyFitness', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Try the demo' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(page.getByText('Demo account.')).toBeVisible();
  await snap(page, '30-demo-today');

  await page.getByRole('link', { name: 'Challenges' }).first().click();
  await expect(page.getByText('Steps this week').first()).toBeVisible();
  await page.getByText('Steps this week').first().click();
  await expect(page.getByRole('heading', { name: 'Steps this week' })).toBeVisible();

  await page.goto('/me');
  await expect(page.getByRole('button', { name: 'Delete Gauntlet account' })).toHaveCount(0);
  await page.goto('/sources');
  await expect(page.getByText('Demo account.')).toBeVisible();
  await expect(page.locator('.error')).toHaveCount(0);
});

test('profiles: trophy board, your own stats, and unfriending', async ({ page }) => {
  await signIn(page);

  // A friend's profile: their record and trophies (Maya won Step Wars).
  await page.goto('/friends');
  await page.getByRole('link', { name: /Maya Rodriguez/ }).click();
  await expect(page.getByRole('heading', { name: 'Maya Rodriguez' })).toBeVisible();
  await expect(page.getByText('Trophy board')).toBeVisible();
  await expect(page.getByText('Step Wars').first()).toBeVisible();
  // Maya hasn't shared her stats.
  await expect(page.getByText(/keeps their stats and milestones to themselves/)).toBeVisible();
  await snap(page, '40-profile-friend');

  // Your own profile always shows your stats, with the switch to share them.
  await page.goto('/me');
  await page.getByRole('link', { name: /Your profile/ }).click();
  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible();
  await expect(page.getByText('All-time stats')).toBeVisible();
  await expect(page.getByText('Best step day')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Share stats and milestones' })).toBeVisible();
  await snap(page, '41-profile-me');

  // Unfriend from the profile, after confirming.
  await page.goto('/friends');
  await page.getByRole('link', { name: /Sam Kim/ }).click();
  await expect(page.getByRole('heading', { name: 'Sam Kim' })).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Unfriend' }).click();
  await expect(page.getByRole('button', { name: 'Add friend' })).toBeVisible();
  await page.goto('/friends');
  await expect(page.getByText('Maya Rodriguez')).toBeVisible();
  await expect(page.getByText('Sam Kim')).toHaveCount(0);
});

test('fresh data: sync now, pull to refresh, and choosing which source counts', async ({
  page,
}) => {
  await signIn(page);

  // Pull down from the top of Today to sync.
  await page.evaluate(async () => {
    const fire = (type: string, y: number) => {
      const t = new Touch({ identifier: 1, target: document.body, clientX: 200, clientY: y });
      document.body.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          touches: type === 'touchend' ? [] : [t],
          changedTouches: [t],
        }),
      );
    };
    fire('touchstart', 100);
    for (let y = 120; y <= 300; y += 30) fire('touchmove', y);
    fire('touchend', 300);
  });
  await expect(page.locator('.toast')).toHaveText(/Up to date|Updated/);

  await page.goto('/sources');
  await expect(page.getByText('Fresh data')).toBeVisible();
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.locator('.toast')).toHaveText(/Up to date|Updated/);

  // Distance comes from the watch and from logged workouts: pick one, then go back to automatic.
  const distance = page.getByRole('group', { name: 'Distance source' });
  await expect(distance).toBeVisible();
  await expect(distance.getByRole('button', { name: 'Automatic' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await distance.getByRole('button', { name: 'Logged workouts' }).click();
  await expect(distance.getByRole('button', { name: 'Logged workouts' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await snap(page, '43-source-priority');
  await distance.getByRole('button', { name: 'Automatic' }).click();
  await expect(distance.getByRole('button', { name: 'Automatic' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('Trends chart: tap or drag to see a day, arrows to step, Show total to go back', async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Trends' }).click();
  const days = page.getByRole('listbox', { name: 'Steps per day' });
  await expect(days).toBeVisible();
  const bars = days.getByRole('option');
  const n = await bars.count();
  expect(n).toBeGreaterThan(3);

  // Tap today's bar: the big number shows that day.
  const today = days.getByRole('option', { name: /, today$/ });
  await today.click();
  await expect(today).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.big')).toContainText(/on (Mon|Tue|Wed|Thu|Fri|Sat|Sun), /);
  await snap(page, '44-trends-picked');

  // Drag across to the first bar.
  const box = (await days.boundingBox())!;
  await page.mouse.move(box.x + box.width - 5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 3, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(bars.first()).toHaveAttribute('aria-selected', 'true');

  // Keyboard: one step right.
  await days.focus();
  await page.keyboard.press('ArrowRight');
  await expect(bars.nth(1)).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('button', { name: 'Show total' }).click();
  await expect(page.locator('.big')).toContainText('vs last');
  await expect(days.locator('[aria-selected="true"]')).toHaveCount(0);
});

test('server admin page is for admins only, with backups', async ({ page }) => {
  // A normal person has no link and is sent home from the address.
  await signIn(page);
  await page.goto('/me');
  await expect(page.getByText('Data sources & privacy')).toBeVisible();
  await expect(page.getByText('Server admin')).toHaveCount(0);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await page.evaluate(() => localStorage.clear());
  await page.context().clearCookies();

  // Riley is the server admin in the demo.
  await signIn(page, 'riley@example.com');
  await page.goto('/me');
  await page.getByRole('link', { name: /Server admin/ }).click();
  await expect(page.getByRole('heading', { name: 'Server admin' })).toBeVisible();
  await expect(page.getByText('Everyone is syncing fine.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back up now' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Download' }).first()).toBeVisible();
  await snap(page, '5a-admin');

  // Restore needs the word RESTORE typed.
  await page.getByRole('button', { name: 'Restore' }).first().click();
  const go = page.getByRole('dialog').getByRole('button', { name: 'Restore' });
  await expect(go).toBeDisabled();
  await page.getByLabel('Type RESTORE to confirm').fill('RESTORE');
  await expect(go).toBeEnabled();
  await snap(page, '5b-admin-restore');
  await page.getByRole('button', { name: 'Cancel' }).click();
});
