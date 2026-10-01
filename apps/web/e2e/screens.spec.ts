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
  await page.getByRole('button', { name: /Connect Garmin/ }).click();
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

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: /Disconnect Garmin/ }).click();
  await expect(page.getByRole('button', { name: /Connect Garmin/ })).toBeVisible();
});
