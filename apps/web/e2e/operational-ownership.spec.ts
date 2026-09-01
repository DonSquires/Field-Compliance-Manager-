import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await installSupabaseFixtures(page);
});

test('approval review names the assigned decision owner and viewer authority', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/approvals');

  await expect(page.getByRole('heading', { name: 'Approvals and activity' })).toBeVisible();
  await expect(page.getByRole('complementary').getByText('Publish North District evening patrol')).toBeVisible();
  await expect(page.getByText('Decision owner').locator('..')).toContainText('Jordan Lee');
  await expect(page.getByText('Your authority').locator('..')).toContainText('View only');
  await expect(page.getByText('Jordan Lee owns this decision. Your current scope is view only.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review approval' })).toHaveCount(0);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});