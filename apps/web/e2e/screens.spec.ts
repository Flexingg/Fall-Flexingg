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

// People in a US locale get miles and pounds by default; these tests were written in metric, so each
// browser starts with that choice (unless a test has already picked something else).
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      if (!localStorage.getItem('gauntlet.display'))
        localStorage.setItem('gauntlet.display', JSON.stringify({ units: 'metric' }));
    } catch {
      /* storage blocked */
    }
  });
});

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

  // Leaving has no "Are you sure?": it happens at once, with an Undo for 5 seconds.
  await page.getByRole('button', { name: 'Leave challenge' }).click();
  await expect(page.getByRole('heading', { name: 'Challenges' })).toBeVisible();
  await expect(page.getByRole('status').getByText(/^Left October Step Open/)).toBeVisible();
  await snap(page, '81-leave-undo-toast');
  // Undo brings it back (and nothing was sent to the server).
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('October Step Open', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('October Step Open', { exact: true })).toBeVisible();
  // Put things back so the test can run again: leave for real and let the 5 seconds run out.
  await page.getByText('October Step Open', { exact: true }).click();
  await page.getByRole('button', { name: 'Leave challenge' }).click();
  await expect(page.getByRole('heading', { name: 'Challenges' })).toBeVisible();
  await expect(page.getByText('October Step Open', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0, { timeout: 9000 });
  await page.reload();
  await page.getByRole('button', { name: 'Discover' }).click();
  await expect(page.getByText('October Step Open', { exact: true })).toBeVisible();
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
  // Frames at exact times: hold the splash, pause every animation and jump to a moment (ms).
  await page.goto('/login?splash=hold');
  const splash = page.getByRole('img', { name: /^Gauntlet\. Throw it down/ });
  await expect(splash).toBeVisible();
  const at = (ms: number) =>
    page.evaluate((t) => {
      for (const a of document.getAnimations()) {
        a.pause();
        a.currentTime = t;
      }
    }, ms);
  await at(400);
  await snap(page, '30-splash-early');
  // "Step it up." holds for a beat once the logo has formed.
  await at(1000);
  await snap(page, '31-splash-hold');
  await expect(page.locator('.splash-words b.first')).toHaveCSS('opacity', '1');
  // While the action word changes (step, burn, lift, ...), nothing else moves: the word's slot,
  // and so " it up.", stay exactly where they are.
  const slot = page.locator('.splash-words');
  const a = await slot.boundingBox();
  await at(1350);
  await snap(page, '32-splash-words');
  await at(1650);
  const b = await slot.boundingBox();
  expect(a).not.toBeNull();
  expect(b).toEqual(a);
  // Then THROW IT DOWN lands mid-screen (about 2.4 s in)...
  const text = page.locator('.splash-throw b');
  await at(2500);
  await snap(page, '33-splash-throw');
  await expect(text).toBeInViewport();
  const landed = await text.boundingBox();
  // ...and drives on down the screen, wiping the splash away to the app behind it.
  await at(2950);
  await snap(page, '34-splash-wipe');
  const lower = await text.boundingBox();
  expect(lower!.y).toBeGreaterThan(landed!.y + 100);

  // Played normally it gets out of the way by itself in a little over 3 seconds.
  await page.goto('/login?splash=1');
  await expect(splash).toBeVisible();
  await expect(splash).toHaveCount(0, { timeout: 6000 });
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

  // Unfriend from the profile: no confirm dialog, an Undo toast instead, and it really happens
  // once the 5 seconds are up.
  await page.goto('/friends');
  await page.getByRole('link', { name: /Sam Kim/ }).click();
  await expect(page.getByRole('heading', { name: 'Sam Kim' })).toBeVisible();
  await page.getByRole('button', { name: 'Unfriend' }).click();
  await expect(page.getByRole('button', { name: 'Add friend' })).toBeVisible();
  await expect(page.getByRole('status').getByText('Unfriended Sam Kim')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0, { timeout: 9000 });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Add friend' })).toBeVisible();
  await page.goto('/friends');
  await expect(page.getByText('Maya Rodriguez')).toBeVisible();
  await expect(page.getByText('Sam Kim')).toHaveCount(0);
});

test('undo: unfriending can be taken back, and the crew list follows', async ({ page }) => {
  await signIn(page);
  await page.goto('/friends');
  await page.getByRole('link', { name: /Dre/ }).first().click();
  await page.getByRole('button', { name: 'Unfriend' }).click();
  await expect(page.getByRole('button', { name: 'Add friend' })).toBeVisible();
  await snap(page, '80-unfriend-undo-toast');
  // While the toast is up, the crew list already leaves them out.
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('link', { name: /Dre/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('link', { name: /Dre/ }).first()).toBeVisible();
  // Nothing was sent: still friends after a reload.
  await page.waitForTimeout(5500);
  await page.reload();
  await expect(page.getByRole('link', { name: /Dre/ }).first()).toBeVisible();
});

test('standings: rank animations leave the leaderboard intact (also with reduced motion)', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/challenges');
  await page.locator('a[href^="/c/"]:not([href="/c/new"])').first().click();
  const rows = page.locator('[data-flip]');
  await expect(rows.first()).toBeVisible();
  const before = await rows.locator('.v').allTextContents();
  expect(before.length).toBeGreaterThan(1);
  await expect(page.locator('.error')).toHaveCount(0);
  // Fresh numbers arrive: nothing breaks, order and scores settle to what the server says.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.reload();
  await expect(rows.first()).toBeVisible();
  expect(await rows.locator('.v').allTextContents()).toEqual(before);
  // No leftover slide transforms once settled.
  await page.waitForTimeout(800);
  expect(
    await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).style.transform)),
  ).toEqual(before.map(() => ''));
  await snap(page, '82-standings');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await expect(rows.first()).toBeVisible();
  await snap(page, '83-standings-reduced-motion');
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

test('reacts to and comments on a feed item', async ({ page }) => {
  await signIn(page);
  const row = page.locator('.rx-row').first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Add a reaction' }).click();
  await row.getByRole('button', { name: 'React 🔥' }).click();
  await expect(row.getByRole('button', { name: /^🔥 \d+, you reacted$/ })).toBeVisible();
  await snap(page, '50-feed-reaction');

  // Open the item and leave a comment.
  await row.getByRole('link', { name: /^Comment/ }).click();
  await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^🔥 \d+, you reacted$/ })).toBeVisible();
  await page.getByLabel('Add a comment').fill('Strong work!');
  await page.getByRole('button', { name: 'Post' }).click();
  await expect(page.locator('.comment .body', { hasText: 'Strong work!' })).toBeVisible();
  await snap(page, '51-feed-comments');

  // The author can delete it again.
  await page.getByRole('button', { name: /^Delete comment: Strong work/ }).click();
  await expect(page.locator('.comment .body', { hasText: 'Strong work!' })).toHaveCount(0);
  // Undo brings it back; deleting again and waiting makes it stick.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.comment .body', { hasText: 'Strong work!' })).toBeVisible();
  await page.getByRole('button', { name: /^Delete comment: Strong work/ }).click();
  await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0, { timeout: 9000 });
  await page.reload();
  await expect(page.locator('.comment .body', { hasText: 'Strong work!' })).toHaveCount(0);
});

test('nudges a friend from their profile', async ({ page }) => {
  await signIn(page);
  await page.goto('/friends');
  await page.getByText('Maya Rodriguez').first().click();
  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
  await snap(page, '52-profile-nudge');
  await page.getByRole('button', { name: 'Nudge Maya' }).click();
  await expect(page.getByRole('button', { name: 'Nudged Maya' })).toBeDisabled();
  await snap(page, '53-nudged');
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

test('team challenge: set up two teams, pick and switch teams, shuffle before the start', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/c/new');
  await page.getByLabel('Challenge name').fill('Team Sprint');
  await page.getByRole('button', { name: 'Steps' }).click();
  // Start tomorrow so teams can still be rearranged.
  await page
    .getByRole('group', { name: 'Duration' })
    .getByRole('button', { name: 'Custom' })
    .click();
  const dayOut = (n: number) =>
    page.evaluate((k) => new Date(Date.now() + k * 864e5).toLocaleDateString('en-CA'), n);
  await page.getByLabel('End date').fill(await dayOut(4));
  await page.getByLabel('Start date').fill(await dayOut(1));
  await page.getByRole('button', { name: 'Invite Maya Rodriguez' }).click();
  await page.getByRole('switch', { name: 'Play in teams' }).click();
  await expect(page.getByText('Average of everyone on the team who scored.')).toBeVisible();
  await page.getByRole('button', { name: 'I’m on this team' }).click();
  await snap(page, '51-new-team-challenge');
  await page.getByRole('button', { name: 'Start challenge' }).click();

  await expect(page.getByRole('heading', { name: 'Team Sprint' })).toBeVisible();
  const board = page.getByLabel('Team leaderboard');
  await expect(board.getByText('Red Rockets')).toBeVisible();
  await expect(board.getByText('Blue Blazers')).toBeVisible();
  // Alex starts on Blue; switch to Red until the challenge starts.
  const mine = page.getByRole('group', { name: 'Pick a team' });
  await expect(mine.getByRole('button', { name: /Blue Blazers/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await mine.getByRole('button', { name: /Red Rockets/ }).click();
  await expect(mine.getByRole('button', { name: /Red Rockets/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Shuffle teams evenly' }).click();
  await expect(page.getByText('Teams shuffled')).toBeVisible();
  await snap(page, '52-team-challenge');
});

test('recurring challenge: repeat weekly, with the repeat label on the page and in the list', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/c/new');
  await page.getByLabel('Challenge name').fill('Weekly Steps');
  await page.getByRole('button', { name: 'Steps' }).click();
  await page.getByRole('button', { name: '7 days' }).click();
  await page.getByRole('switch', { name: 'Repeat this challenge' }).click();
  await expect(page.getByText('Each round runs 7 days.')).toBeVisible();
  await snap(page, '53-new-recurring');
  await page.getByRole('button', { name: 'Start challenge' }).click();
  await expect(page.getByRole('heading', { name: 'Weekly Steps' })).toBeVisible();
  await expect(page.getByText(/Repeats weekly/).first()).toBeVisible();
  await expect(page.getByLabel('Series').getByText('Round 1')).toBeVisible();
  await snap(page, '54-recurring-challenge');
  await page.goto('/challenges');
  const row = page.locator('.item', { hasText: 'Weekly Steps' });
  await expect(row.getByText('Weekly', { exact: true })).toBeVisible();
});

test('head to head on a friend: shared stats side by side, or just the record', async ({
  page,
}) => {
  await signIn(page);

  // Dre shares his stats: numbers for both of you, and the Step Wars record.
  await page.goto('/friends');
  await page.getByRole('link', { name: /Dre Thomas/ }).click();
  const h2h = page.getByLabel('Head to head');
  await expect(h2h).toBeVisible();
  await expect(h2h.getByLabel('Challenge record')).toContainText(/You \d+ – \d+ Dre/);
  await expect(h2h.getByRole('group', { name: /^Steps: you [\d,]+, Dre [\d,]+/ })).toBeVisible();
  await h2h.getByRole('button', { name: 'Month' }).click();
  await expect(h2h.getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'true');
  await expect(h2h.getByRole('group', { name: /^Steps:/ })).toBeVisible();
  await snap(page, '60-head-to-head');

  // Maya keeps her stats to herself: only the record and a note.
  await page.goto('/friends');
  await page.getByRole('link', { name: /Maya Rodriguez/ }).click();
  const hidden = page.getByLabel('Head to head');
  await expect(hidden.getByText(/keeps their stats private/)).toBeVisible();
  await expect(hidden.getByRole('group')).toHaveCount(0);
  await snap(page, '60-head-to-head-private');

  // Your own profile has no head to head.
  await page.goto('/me');
  await page.getByRole('link', { name: /Your profile/ }).click();
  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible();
  await expect(page.getByLabel('Head to head')).toHaveCount(0);
});

test('Trends Compare overlays the previous period and the picked day shows both', async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Trends' }).click();
  const days = page.getByRole('listbox', { name: 'Steps per day' });
  await expect(days).toBeVisible();
  await expect(days.locator('.ghost')).toHaveCount(0);

  const compare = page.getByRole('button', { name: 'Compare' });
  await expect(compare).toHaveAttribute('aria-pressed', 'false');
  await compare.click();
  await expect(compare).toHaveAttribute('aria-pressed', 'true');
  await expect(days.locator('.ghost')).toHaveCount(await days.getByRole('option').count());
  await expect(page.locator('.chart-legend')).toContainText('This week');
  await expect(page.locator('.chart-legend')).toContainText('Last week');

  // Pick the first bar (a past day): the headline has this week and last week.
  await days.getByRole('option').first().click();
  await expect(page.locator('.big')).toContainText(
    /on (Mon|Tue|Wed|Thu|Fri|Sat|Sun), .* · [\d,]+ last week/,
  );
  await snap(page, '61-trends-compare');

  // It is remembered across visits.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Compare' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Compare' }).click();
  await expect(page.getByRole('listbox', { name: 'Steps per day' }).locator('.ghost')).toHaveCount(
    0,
  );
});

test('workout detail: from Trends and from What counted', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Trends' }).click();
  await page.getByLabel('Metric').selectOption('lift_volume');
  const recent = page.getByLabel('Recent workouts');
  await expect(recent).toBeVisible();

  // The newest session has Squat and Bench Press, with a warm-up in each.
  await recent
    .getByRole('link', { name: /Strength workout · 2 exercises/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: /Strength workout/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Squat' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Bench Press' })).toBeVisible();
  await expect(page.getByText('Warm-up').first()).toBeVisible();
  await expect(page.getByText('Best est. 1RM').first()).toBeVisible();
  await expect(page.getByText('Liftosaur')).toBeVisible();
  await snap(page, '62-workout-strength');

  // A run from the challenge's What counted list.
  await page.goto('/challenges');
  await page.getByText('Weekend 100K').click();
  const section = page.getByLabel('What counted');
  await section.getByRole('button', { name: 'Previous day' }).click();
  await section.getByRole('button', { name: 'You' }).click();
  await section
    .getByRole('link', { name: /Running/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Running' })).toBeVisible();
  await expect(page.getByText('avg heart rate (bpm)')).toBeVisible();
  await expect(page.getByText('minutes', { exact: true })).toBeVisible();
  await snap(page, '63-workout-run');

  // Someone else's, where Show Events lets you see it.
  await page.goto('/challenges');
  await page.getByText('Weekend 100K').click();
  await section.getByRole('button', { name: 'Previous day' }).click();
  await section.getByRole('button', { name: 'Maya', exact: true }).click();
  await section
    .getByRole('link', { name: /Running/ })
    .first()
    .click();
  await expect(page.getByText(/Maya Rodriguez ·/)).toBeVisible();
  await expect(page.locator('.error')).toHaveCount(0);
});

/** ISO week id ("2026-W48") of a date, to open a recap without importing app code. */
function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3);
  const week = Math.floor((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 604_800_000) + 1;
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

test('notifications: the bell, the list, opening one, and the weekly recap', async ({ page }) => {
  await signIn(page);
  const bell = page.getByTestId('bell-count');
  await expect(bell).toBeVisible();
  const unread = Number(await bell.textContent());
  expect(unread).toBeGreaterThanOrEqual(3);
  await snap(page, '70-bell');

  await page.getByRole('link', { name: /^Notifications/ }).click();
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(page.getByText('New friend request')).toBeVisible();
  await expect(page.getByText('Your week in review')).toBeVisible();
  await snap(page, '71-notifications');

  // Tapping one marks it read and opens what it is about.
  await page.getByRole('button', { name: /You lost the lead/ }).click();
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
  await page.goto('/');
  await expect(page.getByTestId('bell-count')).toHaveText(String(unread - 1));

  // The recap link opens the week as a card.
  await page.getByRole('link', { name: /^Notifications/ }).click();
  await page.getByRole('button', { name: /Your week in review/ }).click();
  await expect(page).toHaveURL(/\/recap\/\d{4}-W\d{2}$/);
  await expect(page.getByLabel('Weekly recap')).toBeVisible();
  await expect(page.getByLabel('Weekly recap').getByText('steps', { exact: true })).toBeVisible();
  await expect(page.getByText('Distance', { exact: true })).toBeVisible();
  await expect(page.locator('.error')).toHaveCount(0);
  await snap(page, '73-recap');

  // Mark everything read: the badge goes away.
  await page.goto('/notifications');
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(page.getByText(/\d+ unread/)).toHaveCount(0);
  await page.goto('/');
  await expect(page.getByTestId('bell-count')).toHaveCount(0);
});

test('notification settings: a switch per kind that sticks, and honest push status', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/me');
  await page.getByRole('link', { name: /^Notifications/ }).click();
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  // This demo server has no push keys, so the page says so instead of offering a dead switch.
  await expect(page.getByText(/Push isn.t set up on this server/)).toBeVisible();

  const nudges = page.getByRole('switch', { name: 'Nudges from friends' });
  await expect(nudges).toHaveAttribute('aria-checked', 'true');
  await nudges.click();
  await expect(nudges).toHaveAttribute('aria-checked', 'false');
  await snap(page, '72-notification-settings');

  await page.reload();
  await expect(page.getByRole('switch', { name: 'Nudges from friends' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await page.getByRole('switch', { name: 'Nudges from friends' }).click();
  await expect(page.getByRole('switch', { name: 'Nudges from friends' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

test('the demo account can open its weekly recap', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Try the demo' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  const week = isoWeek(new Date(Date.now() - 14 * 86_400_000));
  await page.goto(`/recap/${week}`);
  await expect(page.getByLabel('Weekly recap')).toBeVisible();
  await expect(page.getByLabel('Weekly recap').getByText('steps', { exact: true })).toBeVisible();
  await expect(page.locator('.error')).toHaveCount(0);
  await snap(page, '74-demo-recap');
  // Trends links to last week.
  await page.goto('/trends');
  await page.getByRole('link', { name: 'Last week' }).click();
  await expect(page).toHaveURL(/\/recap\/\d{4}-W\d{2}$/);
});

// ---------- Month / year in review, calendar heatmap ----------

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

async function demoSignIn(page: Page) {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Try the demo' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

test('month in review: open from Me, step through the cards with taps and keys, close', async ({
  page,
}) => {
  await demoSignIn(page);
  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const label = `${MONTH_NAMES[now.getUTCMonth()]} ${now.getUTCFullYear()}`;

  // Past reviews are listed on Me.
  await page.goto('/me');
  await page.getByRole('link', { name: label }).click();
  await expect(page).toHaveURL(new RegExp(`/review/${month}$`));
  const story = page.getByRole('dialog', { name: `${label} in review` });
  await expect(story).toBeVisible();
  await expect(story.getByTestId('story-card')).toContainText('in review');
  await snap(page, '95-review-intro');

  // Tap right: the headline numbers.
  await page.getByRole('button', { name: 'Next card' }).click();
  await expect(story.getByTestId('story-card')).toContainText('You took');
  await expect(story.getByTestId('story-card')).toContainText('steps');
  await snap(page, '96-review-steps');
  // Tap left goes back; the arrow keys do the same.
  await page.getByRole('button', { name: 'Previous card' }).click();
  await expect(story.getByTestId('story-card')).toContainText('Tap to begin');
  await page.keyboard.press('ArrowRight');
  await expect(story.getByTestId('story-card')).toContainText('You took');
  await page.keyboard.press('ArrowLeft');
  await expect(story.getByTestId('story-card')).toContainText('Tap to begin');

  // Step through to the closing card, which has Share.
  const share = story.getByRole('button', { name: 'Share' });
  for (let i = 0; i < 15 && !(await share.isVisible()); i++)
    await page.keyboard.press('ArrowRight');
  await expect(share).toBeVisible();
  await expect(story.getByTestId('story-card')).toContainText('That was');
  await snap(page, '97-review-end');
  await expect(page.locator('.error')).toHaveCount(0);

  // Close goes back to where we came from.
  await story.getByRole('button', { name: 'Close' }).first().click();
  await expect(page).toHaveURL(/\/me$/);
});

test('year in review opens and tells the year, and a bad period goes home', async ({ page }) => {
  await demoSignIn(page);
  const year = String(new Date().getUTCFullYear());
  await page.goto(`/review/${year}`);
  const story = page.getByRole('dialog', { name: `${year} in review` });
  await expect(story).toBeVisible();
  await expect(story.getByTestId('story-card')).toContainText(`Your ${year}`);
  await page.getByRole('button', { name: 'Next card' }).click();
  await expect(story.getByTestId('story-card')).toContainText('You took');
  const share = story.getByRole('button', { name: 'Share' });
  for (let i = 0; i < 15 && !(await share.isVisible()); i++)
    await page.keyboard.press('ArrowRight');
  await expect(share).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  await page.goto('/review/not-a-month');
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
});

test("Today offers last month's review during the first week of a month", async ({ page }) => {
  await demoSignIn(page);
  // Pretend it is the 3rd of next month: the demo's data month is "last month".
  const now = new Date();
  const fake = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 3, 12));
  await page.clock.setFixedTime(fake);
  await page.goto('/');
  await expect(
    page.getByRole('link', {
      name: new RegExp(`Your ${MONTH_NAMES[now.getUTCMonth()]} in review`),
    }),
  ).toBeVisible();
  await snap(page, '98-review-today-card');
});

test('profile calendar heatmap: renders your year and a tapped day shows its value', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/me');
  await page.getByRole('link', { name: /Your profile, trophies/ }).click();
  const heat = page.getByRole('group', { name: /Steps by day/ });
  await expect(heat).toBeVisible();
  await expect(page.locator('.hm-cell[data-l="4"]').first()).toBeVisible();
  // One tab stop for the whole grid, not 365.
  await expect(page.locator('.hm-grid [tabindex="0"]')).toHaveCount(1);
  await snap(page, '99-profile-heatmap');

  // Tap a day with steps: the readout shows its date and number.
  const day = page.getByRole('button', { name: /: 9,412 steps$/ });
  await day.click();
  await expect(page.getByTestId('heatmap-readout')).toContainText('9,412 steps');
  // The arrow keys move between days (up = the day before).
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('heatmap-readout')).toContainText('12,100 steps');

  // Another stat from the picker.
  await page.getByLabel('Show on the calendar').selectOption('distance');
  await expect(page.getByRole('group', { name: /Distance by day/ })).toBeVisible();
  await expect(page.locator('.error')).toHaveCount(0);
});

test('a side bet: set on create, shown on the challenge, owed and paid up at the end', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/c/new');
  await page.getByLabel('Challenge name').fill('Coffee Sprint');
  await page.getByRole('button', { name: 'Steps' }).click();
  await page.getByRole('button', { name: 'Loser picks the next challenge' }).click();
  await expect(page.getByLabel('Side bet', { exact: true })).toHaveValue(
    'Loser picks the next challenge',
  );
  await snap(page, '90-new-side-bet');
  await page.getByLabel('Side bet', { exact: true }).fill('Loser buys coffee');
  await page.getByRole('button', { name: 'Start challenge' }).click();
  await expect(page.getByRole('heading', { name: 'Coffee Sprint' })).toBeVisible();
  await expect(
    page.getByLabel('Side bet', { exact: true }).getByText('Loser buys coffee'),
  ).toBeVisible();
  await snap(page, '91-side-bet-detail');

  // A finished challenge: Dre lost, Alex won and marks it paid up.
  await page.goto('/challenges');
  await page.getByRole('button', { name: 'Finished' }).click();
  await page.getByText('Coffee Run').click();
  const result = page.getByLabel('Side bet result');
  await expect(result.getByText('Dre owes it')).toBeVisible();
  await page.getByRole('button', { name: 'Mark as paid up' }).click();
  await expect(result.getByText('Paid up ✓')).toBeVisible();
  await snap(page, '92-side-bet-paid');

  // Rematch from the detail page carries the bet and starts a series.
  await page.getByRole('button', { name: 'Rematch' }).click();
  await expect(page.getByRole('heading', { name: 'Rematch: Coffee Run' })).toBeVisible();
  await expect(
    page.getByLabel('Side bet', { exact: true }).getByText('Loser buys coffee'),
  ).toBeVisible();
  const series = page.getByLabel('Rematch series');
  await expect(series).toContainText('You 1 – 0 Dre');
  await snap(page, '93-rematch-series');
});

test('the invite QR sheet shows a code and the link', async ({ page }) => {
  await signIn(page);
  await page.goto('/challenges');
  await page.getByText('Weekend 100K').click();
  await page.getByRole('button', { name: 'Show QR code' }).click();
  const sheet = page.getByRole('dialog', { name: 'Invite QR code' });
  await expect(sheet.getByText('Weekend 100K')).toBeVisible();
  await expect(sheet.locator('canvas')).toBeVisible();
  await expect(sheet.getByText(/https?:\/\/\S+\/j\/\S+/)).toBeVisible();
  await expect(sheet.getByText(/Link expires/)).toBeVisible();
  // The code is actually drawn: dark modules on a white ground.
  const dark = await sheet.locator('canvas').evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i]! < 60) n++;
    return n;
  });
  expect(dark).toBeGreaterThan(1000);
  await snap(page, '94-qr-sheet');
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toHaveCount(0);

  // The friend invite has one too.
  await page.goto('/friends');
  await page.getByRole('button', { name: 'Show QR code' }).click();
  await expect(page.getByRole('dialog', { name: 'Invite QR code' })).toContainText(
    'Add Alex Morgan as a friend',
  );
  await expect(
    page.getByRole('dialog', { name: 'Invite QR code' }).locator('canvas'),
  ).toBeVisible();
});

test('units and clock: imperial and 24-hour show up on the screens, and survive a reload', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/me');
  await page.getByRole('button', { name: 'Imperial (mi, lb)' }).click();
  await page.getByRole('button', { name: '24-hour' }).click();
  await expect(page.getByTestId('display-preview')).toContainText('mi');
  await expect(page.getByTestId('display-preview')).toContainText('lb');
  await expect(page.getByTestId('display-preview')).toContainText('19:05');
  await snap(page, '85-settings-units');

  // A distance challenge reads in miles now.
  await page.goto('/challenges');
  await page.getByText('Weekend 100K').click();
  await expect(page.getByLabel('Top three')).toBeVisible();
  await expect(
    page
      .locator('.v.num')
      .filter({ hasText: /\bmi\b/ })
      .first(),
  ).toBeVisible();
  await expect(page.locator('.v.num').filter({ hasText: /\bkm\b/ })).toHaveCount(0);
  await snap(page, '86-challenge-miles');

  // Weights in pounds and the start time on a 24-hour clock.
  await page.goto('/trends');
  await page.getByLabel('Metric').selectOption('lift_volume');
  await page
    .getByLabel('Recent workouts')
    .getByRole('link', { name: /Strength workout · 2 exercises/ })
    .first()
    .click();
  await expect(page.getByRole('region', { name: 'Squat' })).toBeVisible();
  await expect(page.getByText(/\blb\b/).first()).toBeVisible();
  await expect(page.getByText(/\bkg\b/)).toHaveCount(0);
  await snap(page, '87-workout-pounds');

  // A run's start time is on the 24-hour clock ("at 23:30"), distance in miles.
  await page.goto('/trends');
  await page.getByLabel('Metric').selectOption('workouts');
  await page
    .getByLabel('Recent workouts')
    .getByRole('link', { name: /Running/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Running' })).toBeVisible();
  await expect(page.getByText(/ at \d{2}:\d{2}$/)).toBeVisible();
  await expect(page.getByText('mi', { exact: true })).toBeVisible();

  // The choice is saved on the account, not just in this tab.
  await page.reload();
  await page.goto('/me');
  await expect(page.getByRole('button', { name: 'Imperial (mi, lb)' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: '24-hour' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Put it back, so the other tests that share this account still read in kilometres.
  await page.getByRole('button', { name: 'Metric (km, kg)' }).click();
  await page.getByRole('button', { name: '12-hour' }).click();
  await expect(page.getByTestId('display-preview')).toContainText('km');
});

// The installed web app's service worker would answer these requests itself, past the delay below.
test.describe('loading placeholders', () => {
  test.use({ serviceWorkers: 'block' });

  test('a skeleton shows while a slow request is pending, but not over cached data', async ({
    page,
  }) => {
    await signIn(page);
    let slow = true;
    await page.route(/\/api\/friends(\?.*)?$/, async (route) => {
      if (slow) await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.getByRole('link', { name: 'Friends' }).click();
    const loading = page.getByRole('status', { name: 'Loading' });
    await expect(loading.first()).toBeVisible();
    await expect(loading.first()).toHaveAttribute('aria-busy', 'true');
    // (a plain screenshot, not snap(): snap waits for the network to go quiet, which ends the skeleton)
    if (shots) await page.screenshot({ path: `${shots}/88-skeleton-friends.png` });
    await expect(page.getByText('Maya Rodriguez')).toBeVisible();
    await expect(loading).toHaveCount(0);

    // Back again with the data cached: a refresh happens quietly, with no skeleton.
    await page.getByRole('link', { name: 'Today' }).click();
    await page.getByRole('link', { name: 'Friends' }).click();
    await expect(page.getByText('Maya Rodriguez')).toBeVisible();
    await expect(loading).toHaveCount(0);

    // Reduced motion: the same placeholder, held still.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    slow = true;
    await page.route(/\/api\/notifications(\?.*)?$/, async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    // Open it from inside the app: after a full reload the service worker, not this route, answers.
    await page.evaluate(() => {
      history.pushState({}, '', '/notifications');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(loading.first()).toBeVisible();
    const anim = await page.evaluate(() => {
      const el = document.querySelector('.sk-bar, .sk-circle');
      return el ? getComputedStyle(el).animationName : 'missing';
    });
    expect(anim).toBe('none');
    if (shots) await page.screenshot({ path: `${shots}/89-skeleton-reduced-motion.png` });
  });
});

// ---------- Badges and levels ----------

/** Test-only helpers on the demo server (apps/api/test/demoServer.ts). */
async function earn(
  page: Page,
  key: string,
  tiers: number,
  opts: { seen?: boolean; level?: number; email?: string } = {},
) {
  const res = await page.request.post('/api/_e2e/earn', { data: { key, tiers, ...opts } });
  expect(res.ok()).toBe(true);
}

test('the demo account can look through its sample badges, with no celebration', async ({
  page,
}) => {
  await demoSignIn(page);
  await page.goto('/badges');
  await expect(page.getByRole('heading', { name: 'Badges' })).toBeVisible();
  await expect(page.getByTestId('level-card')).toContainText(/Level \d+/);
  await expect(page.getByTestId('badge-tile').first()).toBeVisible();
  await expect(page.getByTestId('celebration')).toHaveCount(0);
  await expect(page.locator('.error')).toHaveCount(0);
  await snap(page, '100-badges-demo');
});

test('badges page: level, filters, detail sheet, pin to profile (three at most)', async ({
  page,
}) => {
  // Four earned badges that are already seen, so nothing pops up.
  for (const [key, tiers] of [
    ['long-haul', 2],
    ['show-up', 3],
    ['far-out', 1],
    ['make-a-splash', 1],
  ] as const)
    await earn(page, key, tiers, { seen: true });
  await signIn(page);
  await page.goto('/me');
  await page.getByRole('link', { name: /Badges & level/ }).click();
  await expect(page).toHaveURL(/\/badges$/);
  await expect(page.getByTestId('level-card')).toContainText('XP');
  await expect(page.getByText('Limited time', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Earned', { exact: true })).toBeVisible();
  await expect(page.getByText('Secret', { exact: true })).toBeVisible();
  await snap(page, '101-badges');

  // A filter chip narrows the grid.
  const all = await page.getByTestId('badge-tile').count();
  await page.getByRole('button', { name: 'Strength' }).click();
  expect(await page.getByTestId('badge-tile').count()).toBeLessThan(all);
  await page.getByRole('button', { name: 'All', exact: true }).click();

  // The detail sheet: tiers, friends, pin.
  await page.locator('[data-testid=badge-tile][data-key=long-haul]').click();
  const sheet = page.getByRole('dialog', { name: /Badge: Long Haul/ });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel('Tiers')).toContainText('Bronze');
  await expect(sheet.getByTestId('badge-friends')).toContainText('friend');
  await snap(page, '102-badge-sheet');
  await sheet.getByRole('button', { name: 'Pin to profile' }).click();
  await expect(sheet.getByRole('button', { name: 'Unpin from profile' })).toBeVisible();
  await page.keyboard.press('Escape');

  for (const key of ['show-up', 'far-out']) {
    await page.locator(`[data-testid=badge-tile][data-key=${key}]`).click();
    await page.getByRole('button', { name: 'Pin to profile' }).click();
    await expect(page.getByRole('button', { name: 'Unpin from profile' })).toBeVisible();
    await page.keyboard.press('Escape');
  }
  // A fourth is refused with a plain message.
  await page.locator('[data-testid=badge-tile][data-key=make-a-splash]').click();
  await page.getByRole('button', { name: 'Pin to profile' }).click();
  await expect(page.getByText('You can pin up to 3 badges')).toBeVisible();
  await page.keyboard.press('Escape');

  // The profile shows level and the three pinned badges.
  await page.goto('/me');
  await page.getByRole('link', { name: /Your profile/ }).click();
  const card = page.getByTestId('badges-card');
  await expect(card).toContainText(/badges earned/);
  await expect(card.getByLabel(/^Level \d+/)).toBeVisible();
  await expect(card.getByRole('button')).toHaveCount(3);
  await expect(card.getByRole('button', { name: /Long Haul/ })).toBeVisible();
  await snap(page, '103-profile-badges');
  await card.getByRole('link', { name: 'See all', exact: true }).click();
  await expect(page).toHaveURL(/\/badges$/);
});

test("someone else's badges: from their profile, only what they earned", async ({ page }) => {
  // Dre shares his stats (Maya keeps hers private, so her badges 404 and the card stays away).
  await earn(page, 'long-haul', 2, { seen: true, email: 'dre@example.com' });
  await signIn(page);
  await page.goto('/friends');
  await page.getByText('Dre Thomas').click();
  await expect(page.getByTestId('badges-card')).toBeVisible();
  await page.getByTestId('badges-card').getByRole('link', { name: 'See all', exact: true }).click();
  await expect(page.getByRole('heading', { name: "Dre's badges" })).toBeVisible();
  await expect(page.getByTestId('badge-tile').first()).toBeVisible();
  await expect(page.getByText('In progress')).toHaveCount(0);
  await snap(page, '104-friend-badges');

  // Maya keeps her stats private: the card just isn't there, and nothing shows as an error.
  await page.goto('/friends');
  await page.getByText('Maya Rodriguez').click();
  await expect(page.getByText('Head to head')).toBeVisible();
  await expect(page.getByTestId('badges-card')).toHaveCount(0);
  await expect(page.locator('.error')).toHaveCount(0);
});

test('level chips sit next to names on standings, friends and the profile', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Friends' }).click();
  await expect(page.getByText('Maya Rodriguez')).toBeVisible();
  await expect(page.locator('.item .lvl').first()).toBeVisible();
  await snap(page, '105-friends-levels');
  await page.goto('/challenges');
  await page.getByText('Weekend 100K').click();
  await expect(page.getByLabel('Top three')).toBeVisible();
  await expect(page.locator('.item .lvl').first()).toBeVisible();
  // Nothing wider than the phone.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await snap(page, '106-standings-levels');
});

test('celebration: gold gets the full-screen moment once, bronze gets a toast', async ({
  page,
}) => {
  await earn(page, 'show-up', 3, { level: 6 });
  await signIn(page);
  const cele = page.getByTestId('celebration');
  await expect(cele).toBeVisible();
  await expect(cele).toContainText('Gold');
  await expect(cele).toContainText('Show Up');
  await expect(cele).toContainText('+95 XP');
  await expect(cele).toContainText("You're now level 6");
  await page.waitForTimeout(1600);
  await snap(page, '107-celebration');
  await cele.getByRole('button', { name: 'Nice' }).click();
  await expect(cele).toHaveCount(0);
  // It was marked seen, so it does not come back.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.getByTestId('celebration')).toHaveCount(0);

  // Bronze: a toast, not a screen.
  await earn(page, 'make-a-splash', 1);
  await page.reload();
  await expect(
    page.getByRole('status').filter({ hasText: 'You earned Bronze · Make a Splash' }),
  ).toBeVisible();
  await expect(page.getByTestId('celebration')).toHaveCount(0);
  await snap(page, '108-badge-toast');
});

test('celebration with reduced motion is just the card, and a tap anywhere moves on', async ({
  browser,
}) => {
  const ctx = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 390, height: 844 },
    baseURL: 'http://localhost:4173',
  });
  const page = await ctx.newPage();
  await earn(page, 'show-up', 4);
  await signIn(page);
  const cele = page.getByTestId('celebration');
  await expect(cele).toBeVisible();
  await expect(cele).toContainText('Platinum');
  await page.mouse.click(40, 400);
  await expect(cele).toHaveCount(0);
  await ctx.close();
});

test('a friend earning gold shows in the feed with its medal', async ({ page }) => {
  const res = await page.request.post('/api/_e2e/feed-badge', {
    data: {
      email: 'maya@example.com',
      name: 'Million Stepper',
      tier: 3,
      tierName: 'gold',
      icon: 'trophy',
      more: 2,
    },
  });
  expect(res.ok()).toBe(true);
  await signIn(page);
  const row = page.locator('.item', { hasText: 'earned Gold · Million Stepper' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('+2 more');
  await expect(row.locator('svg.bi')).toBeVisible();
  await snap(page, '109-feed-badge');
  await row.getByRole('link').first().click();
  await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
  await expect(page.locator('svg.bi')).toBeVisible();
});

test('Today offers a running limited-time badge, and it opens the badge', async ({ page }) => {
  await signIn(page);
  const card = page.getByTestId('limited-badge');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Summer Sprint');
  await expect(card).toContainText(/Ends in \d+ days/);
  await snap(page, '110-today-limited');
  await card.click();
  const sheet = page.getByRole('dialog', { name: /Summer Sprint/ });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Pin to profile' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.goto('/badges');
  await expect(page.getByText('Limited time', { exact: true }).first()).toBeVisible();
});

test('year in review lists the badges you earned in it', async ({ page }) => {
  await earn(page, 'show-up', 3, { seen: true });
  await signIn(page);
  const year = String(new Date().getUTCFullYear());
  await page.goto(`/review/${year}`);
  const story = page.getByRole('dialog', { name: `${year} in review` });
  const card = story.getByTestId('story-card');
  await page.getByRole('button', { name: 'Next card' }).click();
  for (let i = 0; i < 14 && !(await card.getByText(/Badges you earned/).isVisible()); i++)
    await page.keyboard.press('ArrowRight');
  await expect(card).toContainText('Badges you earned this year');
  await expect(card).toContainText('Show Up');
  await snap(page, '111-review-badges');
});

test('a badge notification opens the badges page, and has its own switch', async ({ page }) => {
  await page.request.post('/api/_e2e/notify-badge');
  await signIn(page);
  await page.getByRole('link', { name: /^Notifications/ }).click();
  await page
    .getByRole('button', { name: /Badge earned/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/badges$/);
  await page.goto('/me/notifications');
  await expect(page.getByText('Badges you earn')).toBeVisible();
});

test('Admin → Badges: lists, the editor with its checks, preview, publish and retire', async ({
  page,
}) => {
  await signIn(page, 'riley@example.com');
  await page.goto('/admin');
  await page.getByRole('link', { name: /Badges/ }).click();
  await expect(page).toHaveURL(/\/admin\/badges$/);
  const list = page.getByTestId('admin-badge-list');
  await expect(list).toContainText('Long Haul');
  await expect(list).toContainText('Lifetime steps: 100k · 1M · 5M · 10M');
  await expect(list).toContainText('Built-in');
  await snap(page, '112-admin-badges');
  await page.getByRole('tab', { name: /Drafts/ }).click();
  await expect(page.getByText('No drafts')).toBeVisible();

  // New badge: checks show inline.
  await page.getByRole('button', { name: 'New badge' }).click();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('The name needs 2 to 40 characters.')).toBeVisible();
  await expect(page.getByText('Give 1 to 4 tiers, each a number above zero.')).toBeVisible();

  await page.getByLabel('Name', { exact: true }).fill('E2E Strider');
  await expect(page.getByLabel('Key')).toHaveValue('e2e-strider');
  await page.getByLabel('Description').fill('Walk {n} steps in total.');
  await page.getByLabel('Tier 1', { exact: true }).fill('1000');
  await page.getByRole('button', { name: 'Add a tier' }).click();
  await page.getByLabel('Tier 2', { exact: true }).fill('500');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Each tier must be bigger than the one before.')).toBeVisible();
  await page.getByLabel('Tier 2', { exact: true }).fill('50000');
  await page.getByRole('button', { name: 'Icon rocket' }).click();

  await page.getByRole('button', { name: 'Preview who would earn it' }).click();
  await expect(page.getByTestId('badge-preview')).toContainText(
    /Would award \d+ (people|person) now/,
  );
  await snap(page, '113-admin-editor');

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeVisible();
  await expect(page.getByLabel('Key')).toBeDisabled();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Publish this badge?' })).toContainText(
    'awards it quietly to everyone who already qualifies',
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByRole('button', { name: 'Retire' })).toBeVisible();
  await page.getByRole('button', { name: 'Retire' }).click();
  await expect(page.getByRole('dialog', { name: 'Retire this badge?' })).toContainText(
    'People who earned it keep it',
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Retire' }).click();
  await expect(page.getByRole('button', { name: 'Publish again' })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('tab', { name: /Retired/ }).click();
  await expect(page.getByTestId('admin-badge-list')).toContainText('E2E Strider');
});

test('Admin → Badges → Suggested: status, filters, approve into a draft, dismiss', async ({
  page,
}) => {
  await signIn(page, 'riley@example.com');
  await page.goto('/admin/badges');
  await page.getByRole('tab', { name: /Suggested/ }).click();
  const status = page.getByTestId('import-status');
  await expect(status).toContainText('Add ANTHROPIC_API_KEY to deploy/.env to turn this on');
  await expect(page.getByRole('button', { name: 'Check now' })).toBeDisabled();
  await expect(
    page.getByText(/community Garmin Badge Database \(garminbadges.com\) by Next Source/),
  ).toBeVisible();

  const cards = page.getByTestId('suggestion');
  await expect(cards).toHaveCount(2);
  const first = cards.filter({ hasText: 'Sunrise Mile' });
  await expect(first).toContainText('Garmin idea');
  await expect(first).toContainText('First Light');
  await expect(first).toContainText(
    'One run, between 4 am and 7 am, biggest distance: 2 km · 5 km · 10 km',
  );
  await expect(first.getByRole('link', { name: 'View on garminbadges.com' })).toHaveAttribute(
    'href',
    /garminbadges\.com/,
  );
  await snap(page, '114-admin-suggested');

  await page.getByRole('button', { name: /^Skipped/ }).click();
  await expect(page.getByTestId('suggestion')).toContainText('Gauntlet cannot tell golf');
  await page.getByRole('button', { name: /^Failed/ }).click();
  await expect(page.getByTestId('suggestion')).toContainText('did not answer');
  await page.getByRole('button', { name: /^Matched/ }).click();

  // Quick approve makes a draft straight away.
  await cards
    .filter({ hasText: 'Mountain Goat' })
    .getByRole('button', { name: 'Quick approve' })
    .click();
  await expect(cards.filter({ hasText: 'Mountain Goat' })).toHaveCount(0);
  // Approve opens the editor, prefilled; saving makes it a draft you can preview and publish.
  await first.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('First Light');
  await expect(page.getByLabel('Key')).toHaveValue('first-light');
  await snap(page, '115-admin-approve');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('tab', { name: /Drafts/ }).click();
  await expect(page.getByTestId('admin-badge-list')).toContainText('First Light');
  await expect(page.getByTestId('admin-badge-list')).toContainText('Long Weekend');
  await expect(page.getByTestId('admin-badge-list')).toContainText('Garmin idea');
});

test('badge admin is for admins only', async ({ page }) => {
  await signIn(page);
  await page.goto('/admin/badges');
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
});

// ---------- Admin: accounts, challenges, publish all ----------

test('Admin → Accounts: list, filters, an account page, and scheduling a deletion', async ({
  page,
}) => {
  expect((await page.request.post('/api/_e2e/stale-accounts')).ok()).toBe(true);
  await signIn(page, 'riley@example.com');
  await page.goto('/admin');
  await expect(page.getByRole('link', { name: /Accounts \(\d+\)/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Challenges \(\d+ running\)/ })).toBeVisible();
  await snap(page, '120-admin-home');
  await page.getByRole('link', { name: /Accounts/ }).click();
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
  const list = page.getByTestId('admin-user-list');
  await expect(list).toContainText('Alex Morgan');
  await expect(list).toContainText('Taylor Quiet');
  await snap(page, '121-admin-accounts');

  await page.getByRole('button', { name: /^Expired/ }).click();
  await expect(list).toContainText('Taylor Quiet');
  await expect(list).toContainText('Morgan Gone');
  await expect(list).not.toContainText('Alex Morgan');
  await expect(page.getByText(/has not been used at all for 180 days/)).toBeVisible();
  await snap(page, '122-admin-expired');

  await page.getByRole('button', { name: /^All/ }).click();
  await page.getByLabel('Search accounts').fill('casey');
  await expect(list).toContainText('Casey Diaz');
  await expect(list).not.toContainText('Alex Morgan');
  await page.getByRole('link', { name: 'Open Casey Diaz' }).click();
  await expect(page.getByRole('heading', { name: /Casey Diaz/ })).toBeVisible();
  await expect(page.getByText('Remove this account')).toBeVisible();
  await snap(page, '123-admin-account');

  await page.getByRole('button', { name: 'Schedule deletion' }).click();
  const sheet = page.getByRole('dialog', { name: 'Schedule deletion' });
  await expect(sheet).toContainText('30 days');
  await sheet.getByLabel('Reason').fill('Never used it');
  await snap(page, '124-admin-schedule-sheet');
  await sheet.getByRole('button', { name: 'Schedule deletion' }).click();
  await expect(page.getByText(/Scheduled for deletion on/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel scheduled deletion' })).toBeVisible();
  await snap(page, '125-admin-scheduled');

  // Delete now needs their name typed.
  await page.getByRole('button', { name: 'Delete now' }).click();
  const del = page.getByRole('dialog', { name: 'Delete account now' });
  const go = del.getByRole('button', { name: 'Delete now' });
  await expect(go).toBeDisabled();
  await del.getByLabel('Type Casey Diaz to confirm').fill('Casey Diaz');
  await expect(go).toBeEnabled();
  await snap(page, '126-admin-delete-sheet');
  await del.getByRole('button', { name: 'Cancel' }).click();
});

test('the person sees a banner when an admin has scheduled their account, and can keep it', async ({
  page,
}) => {
  // The previous test left Casey scheduled for deletion.
  await signIn(page, 'casey@example.com');
  const banner = page.getByRole('alert').filter({ hasText: 'will be deleted on' });
  await expect(banner).toContainText("because it hasn't been used");
  await snap(page, '127-deletion-banner');
  await page.goto('/notifications');
  await expect(page.getByText('Your account is scheduled for deletion')).toBeVisible();
  await page.goto('/');
  await page.getByRole('button', { name: 'Keep my account' }).click();
  await expect(page.getByText('will be deleted on')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(page.getByText('will be deleted on')).toHaveCount(0);
});

test('Admin → Accounts: clean up expired shows who, then schedules them', async ({ page }) => {
  expect((await page.request.post('/api/_e2e/stale-accounts')).ok()).toBe(true);
  await signIn(page, 'riley@example.com');
  await page.goto('/admin/users');
  await page.getByRole('button', { name: 'Clean up expired' }).click();
  const sheet = page.getByRole('dialog', { name: 'Clean up expired' });
  await expect(sheet).toContainText('Taylor Quiet');
  await expect(sheet).toContainText('Morgan Gone');
  await expect(sheet).toContainText('Nothing is deleted today');
  await snap(page, '128-admin-cleanup');
  await sheet.getByRole('button', { name: /Schedule \d+ for deletion/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: /^Scheduled for deletion/ }).click();
  const list = page.getByTestId('admin-user-list');
  await expect(list).toContainText('Taylor Quiet');
  await expect(page.getByText('cleaned up expired accounts')).toBeVisible();
  await snap(page, '129-admin-scheduled-list');
});

test('Admin → Challenges: filters and opening one', async ({ page }) => {
  await signIn(page, 'riley@example.com');
  await page.goto('/admin');
  await page.getByRole('link', { name: /Challenges \(/ }).click();
  await expect(page.getByRole('heading', { name: 'Challenges' })).toBeVisible();
  const list = page.getByTestId('admin-challenge-list');
  await expect(list).toContainText('Weekend 100K');
  await snap(page, '130-admin-challenges');
  await page.getByRole('button', { name: /^Finished/ }).click();
  await expect(page.getByRole('button', { name: /^Finished/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: /^All/ }).click();
  await page.getByLabel('Search challenges').fill('weekend');
  await expect(list).toContainText('Weekend 100K');
  await expect(list).not.toContainText('Coffee Run');
  await page.getByRole('link', { name: 'Open Weekend 100K' }).click();
  await expect(page.getByLabel('Top three')).toBeVisible();
  await expect(page.getByText('Private challenge, viewing as a server admin')).toBeVisible();
  await snap(page, '131-admin-challenge-detail');
});

test('Admin → Badges: publish all drafts with progress', async ({ page }) => {
  expect((await page.request.post('/api/_e2e/drafts')).ok()).toBe(true);
  await signIn(page, 'riley@example.com');
  await page.goto('/admin/badges');
  await page.getByRole('tab', { name: /Drafts/ }).click();
  const list = page.getByTestId('admin-badge-list');
  await expect(list).toContainText('Early Bird');
  await page.getByLabel('Select Night Owl').check();
  await expect(page.getByRole('button', { name: 'Publish selected (1)' })).toBeVisible();
  await snap(page, '132-admin-drafts');

  await page.getByRole('button', { name: 'Publish selected (1)' }).click();
  const one = page.getByRole('dialog', { name: 'Publish badges' });
  await expect(one).toContainText('Publishes 1 badge');
  await one.getByRole('button', { name: 'Publish 1' }).click();
  await expect(list).not.toContainText('Night Owl');
  await expect(list).toContainText('Early Bird');

  await page.getByRole('button', { name: /^Publish all \(\d+\)/ }).click();
  const all = page.getByRole('dialog', { name: 'Publish badges' });
  await expect(all).toContainText("This can't be undone, but you can retire any of them later.");
  await snap(page, '133-admin-publish-all');
  await all.getByRole('button', { name: /^Publish \d+$/ }).click();
  await expect(page.getByText(/badges? published/).first()).toBeVisible();
  await page.getByRole('tab', { name: /Live/ }).click();
  await expect(page.getByTestId('admin-badge-list')).toContainText('Early Bird');
  await expect(page.getByTestId('admin-badge-list')).toContainText('Weekend Warrior');
  await snap(page, '134-admin-published');
});
