import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test('officer module directory requires both a direct grant and organisation entitlement', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page);
  await signInAsOfficer(page, '/officer/modules');

  await expect(page.getByRole('heading', { name: 'Enabled modules' })).toBeVisible();
  await expect(page.getByText('No enabled field modules are available.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Welfare' })).toHaveCount(0);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});