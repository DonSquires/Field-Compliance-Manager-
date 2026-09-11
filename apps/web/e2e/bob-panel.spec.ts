import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await installSupabaseFixtures(page);
});

test('administrator opens and dismisses the governed Bob workspace accessibly', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/hub');
  const opener = page.getByRole('button', { name: 'Open Bob command center' });
  await opener.click();
  await expect(page).toHaveURL(/\/admin\/bob$/);
  const panel = page.getByLabel('Bob agent workspace');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Governed session')).toBeVisible();
  await expect(panel.locator('.bob-context span').first()).toContainText('Workspace');
  await expect(panel.locator('.bob-context span').first()).toContainText('Bob');
  await expect(panel.getByRole('button', { name: 'Plan work' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Start voice capture' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Close Bob' })).toBeVisible();
  await expect(panel).toHaveClass(/is-expanded/);
  const isMobile = await page.evaluate(() => window.innerWidth < 1100);
  if (isMobile) {
    await expect(panel.getByRole('button', { name: 'Show sessions' })).toBeVisible();
    await expect(panel.getByLabel('Bob sessions')).toBeHidden();
    await panel.getByRole('button', { name: 'Show sessions' }).click();
    await expect(panel.getByLabel('Bob sessions')).toBeVisible();
    await panel.getByRole('button', { name: 'Close sessions' }).click();
  } else {
    await expect(panel.getByLabel('Bob sessions')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Hide sessions' })).toBeVisible();
  }
  await expect(panel.getByLabel('Bob context panel')).toBeHidden();
  await expect(panel.locator('textarea[placeholder="Ask Bob to plan, inspect, explain, or prepare a proposal"]')).toBeVisible();
  await expect(panel).toHaveScreenshot('bob-panel.png');
  await expect(page).toHaveScreenshot('bob-panel-full-page.png', { fullPage: true });

  await panel.getByRole('button', { name: 'Open document studio' }).click();
  const studio = panel.getByLabel('Bob studio');
  await expect(studio).toBeVisible();
  await expect(studio.getByRole('tab', { name: /Documents/ })).toBeVisible();
  await expect(studio.getByRole('tab', { name: /Diagrams/ })).toBeVisible();
  await expect(studio.getByRole('tab', { name: /Media/ })).toBeVisible();
  await expect(studio.getByRole('button', { name: /RFQ response/ })).toBeVisible();
  await expect(studio.getByRole('button', { name: /Employment contract draft/ })).toBeVisible();
  await expect(studio.getByRole('button', { name: /Report design/ })).toBeVisible();
  await expect(panel).toHaveScreenshot('bob-studio.png');

  await panel.getByRole('button', { name: 'Show context panel' }).click();
  await expect(panel.getByLabel('Bob context panel')).toBeVisible();
  await expect(panel.getByRole('tab', { name: 'Audit' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(page).toHaveURL(/\/admin\/hub$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});