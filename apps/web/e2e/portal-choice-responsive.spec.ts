import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test('dual-access portal choice remains clear and contained on desktop and narrow mobile', async ({ page }, testInfo) => {
  const browserErrors = monitorBrowserErrors(page);
  if (testInfo.project.name === 'mobile-chromium') await page.setViewportSize({ width: 320, height: 720 });
  await installSupabaseFixtures(page, { adminRole: 'admin_officer' });
  await signInAsAdmin(page, '/admin/hub');

  await expect(page.getByRole('heading', { name: 'Welcome, Morgan' })).toBeVisible();
  await expect(page.getByText('You have dual access. Choose how you want to work right now.')).toBeVisible();
  const adminChoice = page.getByRole('button', { name: /Admin Portal/ });
  const fieldChoice = page.getByRole('button', { name: /Field Portal/ });
  await expect(adminChoice).toBeVisible();
  await expect(fieldChoice).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const viewport = page.viewportSize();
  for (const choice of [adminChoice, fieldChoice]) {
    const bounds = await choice.boundingBox();
    expect(bounds && viewport && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width).toBe(true);
  }
  await expect(adminChoice.locator('svg')).toHaveCount(1);
  await expect(fieldChoice.locator('svg')).toHaveCount(1);
  await expect(page).toHaveScreenshot('dual-access-portal-choice.png');

  await fieldChoice.click();
  await expect(page).toHaveURL(/\/officer(?:\/|$)/);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});