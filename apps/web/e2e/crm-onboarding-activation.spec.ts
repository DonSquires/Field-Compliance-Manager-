import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-31T10:00:00+12:00'));
  await installSupabaseFixtures(page);
});

test('administrator resumes evidence-backed onboarding and activates a ready prospect', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/onboarding');

  await expect(page.getByRole('heading', { name: 'Account onboarding' })).toBeVisible();
  await page.getByRole('button', { name: /Blocked Harbour Prospect/ }).click();
  await expect(page.getByText('Target overdue')).toBeVisible();
  await expect(page.getByText('An active primary contact is required')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Activate account' })).toHaveCount(0);

  await page.getByRole('button', { name: /Ready Venue Trust/ }).click();
  await expect(page.getByText('All mandatory evidence is ready')).toBeVisible();
  await expect(page).toHaveScreenshot('crm-onboarding-queue.png');
  await page.getByRole('button', { name: 'Advance stage' }).click();
  await expect(page.getByRole('status')).toContainText('Ready Venue Trust advanced to review');
  await page.getByRole('button', { name: 'Activate account' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Activate Ready Venue Trust?' });
  await expect(confirmation).toContainText('lock and recheck');
  await confirmation.getByRole('button', { name: 'Confirm activation' }).click();
  await expect(page.getByRole('status')).toContainText('Ready Venue Trust activated and removed from the incomplete queue');
  await expect(page.getByRole('button', { name: /Ready Venue Trust/ })).toHaveCount(0);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('missing onboarding RPC hides misleading queue totals and recovers on retry', async ({ page }) => {
  let attempts = 0;
  await page.route('**/rest/v1/rpc/get_crm_onboarding_workspace', async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'PGRST202',
          details: 'Searched for the function public.get_crm_onboarding_workspace without parameters.',
          hint: null,
          message: 'Could not find the function public.get_crm_onboarding_workspace without parameters in the schema cache',
        }),
      });
      return;
    }
    await route.fallback();
  });

  await signInAsAdmin(page, '/admin/onboarding');

  const unavailable = page.getByRole('alert');
  await expect(unavailable.getByRole('heading', { name: 'Onboarding data unavailable' })).toBeVisible();
  await expect(unavailable).toContainText('Could not find the function public.get_crm_onboarding_workspace');
  await expect(page.getByText('In progress', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No incomplete onboarding accounts.')).toHaveCount(0);
  await expect(page.getByText('Select an account to resume onboarding.')).toHaveCount(0);

  await unavailable.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('button', { name: /Ready Venue Trust/ })).toBeVisible();
  await expect(page.getByText('In progress', { exact: true })).toBeVisible();
});

test('stale stage rejection preserves context and allows a human retry', async ({ page }) => {
  let attempts = 0;
  await page.route('**/rest/v1/rpc/manage_crm_onboarding_workflow', async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'P0001', message: 'Onboarding ledger changed since it was opened' }),
      });
      return;
    }
    await route.fallback();
  });

  await signInAsAdmin(page, '/admin/onboarding');
  await page.getByRole('button', { name: /Ready Venue Trust/ }).click();
  await page.getByRole('button', { name: 'Advance stage' }).click();

  await expect(page.getByRole('alert')).toContainText('Onboarding ledger changed since it was opened');
  await expect(page.getByRole('button', { name: /Ready Venue Trust/ })).toBeVisible();
  await expect(page.getByText('Onboarding data unavailable')).toHaveCount(0);

  await page.getByRole('button', { name: 'Advance stage' }).click();
  await expect(page.getByRole('status')).toContainText('Ready Venue Trust advanced to review');
});

test('administrator records named ownership and immutable stage history', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/onboarding');

  await page.getByRole('button', { name: /Blocked Harbour Prospect/ }).click();
  await page.getByLabel('Workflow owner').selectOption('11111111-1111-4111-8111-111111111111');
  await page.getByLabel('Stage note').fill('Primary contact follow-up assigned for completion this week.');
  await page.getByRole('button', { name: 'Save ownership' }).click();

  await expect(page.getByRole('status')).toContainText('workflow ownership updated');
  const history = page.locator('.onboarding-history');
  await expect(history.getByText('Primary contact follow-up assigned for completion this week.')).toBeVisible();
  await expect(history.getByText(/Morgan Reed · by Morgan Reed/)).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});