import { addDays, todayIn } from '@gauntlet/shared';
import { FakeSparky } from '@gauntlet/sparky/testing';
import { expect, test, type Page } from '@playwright/test';

/**
 * Direct mode in Chromium: the app talks to a fake SparkyFitness with no Gauntlet server.
 * Needs a build with VITE_ALLOW_DIRECT_IN_BROWSER=1.
 */
const shots = process.env.SCREENSHOT_DIR;

test.skip(!process.env.E2E_DIRECT, 'needs the E2E_DIRECT build (see ci.yml)');

async function snap(page: Page, name: string) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

test('direct mode: personal screens work, friends need a server', async ({ page }) => {
  const fake = new FakeSparky();
  const user = fake.addUser({ id: 'u1', email: 'a@x.test', password: 'p', name: 'Alex Morgan' });
  const today = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
  for (let i = 0; i < 14; i++)
    user.daily.push({
      entry_date: addDays(today, -i),
      source_provider: 'Health Connect',
      total_steps: 9000 + i * 300,
      total_distance_meters: 6000 + i * 200,
      active_calories: 400,
      exercise_minutes: 35,
    });
  const key = fake.mintKey('u1');

  await page.route('https://sparky.test/**', async (route) => {
    const req = route.request();
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
    };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const res = await fake.fetch(req.url(), {
      method: req.method(),
      headers: req.headers(),
      body: req.postData() ?? undefined,
    });
    await route.fulfill({
      status: res.status,
      headers: { 'content-type': 'application/json', ...cors },
      body: await res.text(),
    });
  });

  await page.goto('/login');
  await snap(page, 'direct-00-login');
  await page.getByLabel('SparkyFitness address').fill('https://sparky.test');
  await page.getByLabel('API key').fill(key);
  await page
    .getByRole('button', { name: /connect|sign in|continue/i })
    .first()
    .click();

  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(page.getByText('9,000').first()).toBeVisible();
  await snap(page, 'direct-01-today');

  await page.getByRole('link', { name: 'Trends' }).click();
  await expect(page.getByRole('heading', { name: 'Trends' })).toBeVisible();
  await snap(page, 'direct-02-trends');

  await page.getByRole('link', { name: 'Friends' }).click();
  await expect(page.getByText('This needs a Gauntlet server')).toBeVisible();
  await snap(page, 'direct-03-needs-server');

  await page.goto('/sources');
  await snap(page, 'direct-04-sources');
});
