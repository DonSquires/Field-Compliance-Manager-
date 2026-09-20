import { expect, test } from '@playwright/test';
import { installClientPortalFixtures, monitorBrowserErrors, signInAsClient } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
});

test('a transparency-only client sees what was delivered at its places, in plain words', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installClientPortalFixtures(page);
  // The portal never asks a client where they are.
  await page.addInitScript(() => {
    const geolocation = navigator.geolocation;
    (window as unknown as { __geolocationCalls: number }).__geolocationCalls = 0;
    for (const method of ['watchPosition', 'getCurrentPosition'] as const) {
      const original = geolocation[method].bind(geolocation);
      Object.defineProperty(geolocation, method, { value: (...args: unknown[]) => { (window as unknown as { __geolocationCalls: number }).__geolocationCalls += 1; return (original as (...inner: unknown[]) => unknown)(...args); } });
    }
  });
  await signInAsClient(page);

  // Overview: the delivered-work panel sits first, before observations the agreement does not include.
  await expect(page.getByRole('heading', { name: 'Service overview' })).toBeVisible();
  await expect(page.locator('.place-context-banner')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __geolocationCalls: number }).__geolocationCalls)).toBe(0);
  const presence = page.locator('.client-overview-panel').filter({ hasText: 'Presence at your places' });
  await expect(presence.locator('.client-status-count').filter({ hasText: 'Visits done' })).toContainText('25');
  await expect(presence.locator('.client-status-count').filter({ hasText: 'Visits missed' })).toContainText('2');
  await expect(presence.locator('.client-status-count').filter({ hasText: 'On post' })).toContainText('24h 15m');

  const menu = page.getByRole('button', { name: 'Open navigation' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Service delivered' }).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/client\/delivery$/);
  await expect(page.getByRole('heading', { name: 'Service delivered' })).toBeVisible();
  await expect(page.getByText(/Only shifts already due are counted; the names of individual officers are not shown here\./)).toBeVisible();
  const centre = page.locator('.client-delivery-list article').filter({ hasText: 'Civic Events Centre' });
  await expect(centre).toContainText('25 of 27 contracted visits done · 2 missed visits · 1 late');
  await expect(centre).toContainText('4 guard attendances of 4 rostered · 24h 15m on post');
  await expect(centre).toContainText(/Last on site Sun, 30 Aug|Last on site Sat, 29 Aug/);
  await expect(centre).toHaveClass(/has-missed/);
  const zone = page.locator('.client-delivery-list article').filter({ hasText: 'Civic Event Operations Zone' });
  await expect(zone).toContainText('Nothing was due here in this period.');
  await expect(zone).toContainText('No presence recorded in this period');
  await expect(page.locator('.client-delivery')).toHaveScreenshot('client-delivery.png', { maxDiffPixelRatio: 0.03 });

  await page.getByRole('button', { name: 'Last month' }).click();
  await expect(centre).toContainText('31 of 31 contracted visits done · 1 late');
  await expect(centre).not.toHaveClass(/has-missed/);
  await expect(page.locator('.client-status-count').filter({ hasText: 'On post' })).toContainText('32h 00m');
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('the delivery view is not offered on a scan-only agreement, and the URL does not open it', async ({ page }) => {
  await installClientPortalFixtures(page, { mode: 'scan_only' });
  await signInAsClient(page, '/client/delivery');
  await expect(page).toHaveURL(/\/client$/);
  await expect(page.getByRole('navigation', { name: 'Client portal' }).getByRole('button', { name: 'Service delivered' })).toHaveCount(0);
  await expect(page.locator('.client-overview-panel').filter({ hasText: 'Presence at your places' })).toHaveCount(0);
});

test('an invited client administrator lands on "set your password", sets it, and the acceptance is recorded', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installClientPortalFixtures(page);
  // invite-org writes the organisation and role into the invited user's metadata
  const invitedUser = {
    id: '50505050-5050-4050-8050-505050505050', aud: 'authenticated', role: 'authenticated', email: 'facilities@civic-events.test',
    email_confirmed_at: null, invited_at: '2026-08-29T21:00:00.000Z', app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { display_name: 'Tia Whaanga', role: 'client_admin', role_label: 'Client Administrator', organization_id: '40404040-4040-4040-8040-404040404040', organization_name: 'Civic Events Limited' },
    created_at: '2026-08-29T21:00:00.000Z',
  };
  let passwordSet: string | null = null;
  await page.route('**/auth/v1/user', async (route) => {
    if (route.request().method() === 'PUT') passwordSet = JSON.parse(route.request().postData() ?? '{}').password ?? null;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(invitedUser) });
  });
  let accepted = 0;
  await page.route('**/rest/v1/rpc/accept_client_invitation', async (route) => { accepted += 1; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accepted: 1, organization_id: '40404040-4040-4040-8040-404040404040' }) }); });

  // the link in the invitation email: a session in the URL fragment, type=invite, no password yet
  await page.goto('/auth/callback#access_token=client-e2e-token&expires_in=3600&refresh_token=client-refresh-token&token_type=bearer&type=invite');
  await expect(page.getByRole('heading', { name: 'Welcome to Civic Events Limited' })).toBeVisible();
  await expect(page.getByText('You have been invited as client administrator. Choose a password to finish setting up your account; you will use it to sign in from now on.')).toBeVisible();
  await expect(page.getByLabel('Email address')).toHaveCount(0);
  await page.getByLabel('Choose a password', { exact: true }).fill('Harbour-Lights-2026');
  await page.getByLabel('Confirm your password').fill('Harbour-Lights-2026');
  await page.getByRole('button', { name: 'Set password and continue' }).click();

  // password saved, acceptance recorded once, and the client shell opens
  await expect(page.getByRole('heading', { name: 'Service overview' })).toBeVisible();
  expect(passwordSet).toBe('Harbour-Lights-2026');
  expect(accepted).toBe(1);
  expect(page.url()).toMatch(/\/client/);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});
