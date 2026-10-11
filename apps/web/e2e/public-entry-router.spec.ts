import { expect, test } from '@playwright/test';
import { installClientPortalFixtures, installSupabaseFixtures, signInAsAdmin, signInAsClient } from './fixtures';

test('capability-share invite requires sign-in before acceptance', async ({ page }) => {
  await page.goto('/invite/capability/share-token-e2e');

  await expect(page.getByLabel('Email address')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('a signed-in client accepts the capability-share token through the governed RPC', async ({ page }) => {
  await installClientPortalFixtures(page, { role: 'client_viewer' });
  let acceptedToken: string | null = null;
  await page.route('**/rest/v1/rpc/accept_client_capability_share', async (route) => {
    acceptedToken = (route.request().postDataJSON() as { p_token: string }).p_token;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: 'Service reporting' }) });
  });

  await signInAsClient(page, '/invite/capability/share-token-e2e');
  await expect(page.getByRole('heading', { name: 'Accept shared access' })).toBeVisible();
  await page.getByRole('button', { name: 'Accept shared access' }).click();
  await expect(page.getByRole('status')).toContainText('Access accepted for Service reporting');
  expect(acceptedToken).toBe('share-token-e2e');
});

test('scan operators enter the scan station but admins are redirected to their role portal', async ({ page }) => {
  await installSupabaseFixtures(page, { adminRole: 'scan_operator' });
  await signInAsAdmin(page, '/scan');
  await expect(page).toHaveURL(/\/scan$/);
  await expect(page.getByText('No standalone scan module is enabled', { exact: true })).toBeVisible();

  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await installSupabaseFixtures(page, { adminRole: 'admin' });
  await page.goto('/scan');
  await expect(page.getByLabel('Email address')).toBeVisible();
  await page.getByLabel('Email address').fill('admin@fcm.test');
  await page.getByRole('textbox', { name: 'Password' }).fill('playwright-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin(?:\/hub)?$/);
  await expect(page.getByRole('heading', { name: 'Today at a glance' })).toBeVisible();
});