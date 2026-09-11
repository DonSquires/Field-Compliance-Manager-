import { expect, test } from '@playwright/test';
import { installFreedomCampingFixtures, installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin, signInAsOfficer } from './fixtures';

test('admin records a governed breach action', async ({ page }) => {
  const browserErrors=monitorBrowserErrors(page);await installSupabaseFixtures(page);await signInAsAdmin(page,'/admin/field-ops?area=breach-review');
  await page.getByRole('button',{name:/Select Enforcement Action/}).click();
  await page.getByPlaceholder(/Spoke to vehicle occupant/).fill('Supervisor approved a written warning and follow-up patrol.');
  await page.getByRole('button',{name:/Written Warning/}).click();
  await expect(page.getByText('No breach records found matching the current filter.')).toBeVisible();
  expect(browserErrors,browserErrors.join('\n')).toEqual([]);
});

test('officer breach notification opens the exact admin outcome', async ({ page }) => {
  const browserErrors=monitorBrowserErrors(page);await installFreedomCampingFixtures(page);await signInAsOfficer(page,'/officer/freedom_camping?breach=abababab-abab-4bab-8bab-abababababab');
  const outcome=page.locator('#officer-breach-abababab-abab-4bab-8bab-abababababab');
  await expect(outcome).toHaveClass(/is-context-focus/);
  await expect(outcome).toContainText('Admin outcome · actioned');
  await expect(outcome).toContainText('Written warning approved with supervisor follow-up.');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  expect(browserErrors,browserErrors.join('\n')).toEqual([]);
});