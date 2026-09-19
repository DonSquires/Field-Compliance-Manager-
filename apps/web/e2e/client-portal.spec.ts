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
