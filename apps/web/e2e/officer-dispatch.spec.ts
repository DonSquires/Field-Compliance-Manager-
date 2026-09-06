import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installOfficerScheduleFixtures(page);
});

test('dispatch completion keeps shift context and gives the officer a next command', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsOfficer(page, '/officer/dispatch');

  await expect(page.getByRole('heading', { name: 'Dispatch', exact: true })).toBeVisible();
  await expect(page.getByText('Alarm response', { exact: true })).toBeVisible();
  const complete = page.getByRole('button', { name: 'Mark Completed' });
  await expect(complete).toBeDisabled();
  await page.getByLabel('Outcome notes').fill('Entrance checked, alarm panel reset, and site contact notified.');
  await expect(complete).toBeEnabled();
  await complete.click();

  const receipt = page.getByRole('region', { name: 'Dispatch completion receipt' });
  await expect(receipt).toContainText('Dispatch completed');
  await expect(receipt).toContainText('Receipt cccccccc · shift 66666666');
  await expect(receipt).toContainText('Your shift remains active');
  for (const command of ['Shift home', 'Open map', 'Field report', 'Debrief']) {
    await expect(receipt.getByRole('button', { name: command })).toBeVisible();
  }
  await expect(page.getByText('No active dispatch jobs right now.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await receipt.getByRole('button', { name: 'Open map' }).click();
  await expect(page).toHaveURL(/\/officer\/map$/);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('personal dispatch notification opens the exact assigned job', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsOfficer(page, '/officer/dispatch?job=cccccccc-cccc-4ccc-8ccc-cccccccccccc');

  const job = page.locator('#officer-dispatch-cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  await expect(job).toHaveClass(/is-context-focus/);
  await expect(job.getByText('Alarm response', { exact: true })).toBeVisible();
  await expect(job.getByRole('button', { name: 'Mark Completed' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('route guidance renders the recommended SLA-aware route in the officer portal', async ({ page, context }) => {
  const browserErrors = monitorBrowserErrors(page);
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: -41.2805, longitude: 173.2840 });
  await page.route('**/functions/v1/linz-map-tile**', async (route) => await route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL1XQAAAABJRU5ErkJggg==', 'base64') }));
  await page.route('**/functions/v1/officer-route-guidance', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    if (body.mode === 'plan') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ stops: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', kind: 'dispatch', eta_seconds: 296, distance_meters: 3110, sla_risk: 'on_track' }] }) });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ distance_meters: 3110, duration_seconds: 296, destination_lat: -41.3012, destination_lng: 173.2316, geometry: [[173.2840, -41.2805], [173.2670, -41.2890], [173.2316, -41.3012]], steps: [{ instruction: 'depart Waimea Road', distance_meters: 300 }, { instruction: 'turn left onto Abraham Heights', distance_meters: 1200 }] }) });
  });
  await page.route('**/functions/v1/linz-lookup', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ geometry: { type: 'Polygon', coordinates: [[[173.230, -41.302], [173.233, -41.302], [173.233, -41.300], [173.230, -41.302]]] } }) }));
  await signInAsOfficer(page, '/officer/dispatch');
  const guidance = page.getByRole('region', { name: 'Recommended route guidance' });
  await guidance.getByRole('button', { name: 'Route from here' }).click();
  await expect(guidance).toContainText('Route updated');
  await expect(guidance).toContainText('5 min');
  await expect(guidance).toContainText('3.1 km');
  await expect(guidance).toContainText('turn left onto Abraham Heights');
  await expect(guidance.locator('.leaflet-control-layers')).toContainText('LINZ aerial');
  await expect(guidance).toHaveScreenshot('officer-route-guidance.png');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});