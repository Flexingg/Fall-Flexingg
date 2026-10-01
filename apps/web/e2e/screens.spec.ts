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
  await expect(page.getByText('Garmin Connect')).toBeVisible();
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
