import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await installSupabaseFixtures(page);
});

test('administrator opens and dismisses the governed Bob workspace accessibly', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/hub');
  const opener = page.getByRole('button', { name: 'Open Bob assistant' });
  await opener.click();
  const panel = page.getByLabel('Bob agent workspace');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Governed session')).toBeVisible();
  await expect(panel.locator('.bob-context span').first()).toContainText('Workspace');
  await expect(panel.locator('.bob-context span').first()).toContainText('Overview');
  await expect(panel.getByRole('button', { name: 'Plan work' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Start voice capture' })).toBeVisible();
  const sessionToggle = panel.getByRole('button', { name: 'Show sessions' });
  await expect(panel.locator('textarea[placeholder="Ask Bob to plan, inspect, explain, or prepare a proposal"]')).toBeVisible();
  await expect(panel).toHaveScreenshot('bob-panel.png');
  await expect(page).toHaveScreenshot('bob-panel-full-page.png', { fullPage: true });
  await sessionToggle.click();
  await expect(panel.getByRole('button', { name: 'Hide sessions' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(opener).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});