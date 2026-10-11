import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const OPERATING_ORG_ID = '41414141-4141-4141-8141-414141414141';

test.beforeEach(async ({ page }, testInfo) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installSupabaseFixtures(page, { officerModules: testInfo.title.includes('without Freedom Camping') ? [] : ['freedom_camping'] });
});

test('reports remain focused without Freedom Camping', async ({ page }) => {
  const unscopedModuleRequests: string[] = [];
  const scopedObservationFilters: string[] = [];
  const reportingRoots: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    const select = url.searchParams.get('select') ?? '';
    const reportsHubBreachRead = url.pathname.endsWith('/breach_alerts') && select.includes('zone_id,notes');
    const reportsHubObservationRead = url.pathname.endsWith('/observations') && select.includes('compliance_reason,zone_id');
    const observationPlaceFilter = url.searchParams.get('or') ?? '';
    if (reportsHubBreachRead || (reportsHubObservationRead && !observationPlaceFilter)) unscopedModuleRequests.push(request.url());
    if (reportsHubObservationRead && observationPlaceFilter) scopedObservationFilters.push(observationPlaceFilter);
    if (url.pathname.endsWith('/rpc/get_consolidated_reporting_overview')) {
      reportingRoots.push(String((request.postDataJSON() as { p_root_organization_id?: string }).p_root_organization_id));
    }
  });
  await signInAsAdmin(page, '/admin/reports');
  await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
  await expect(page.getByLabel('Report period start')).toBeVisible();
  await expect(page.getByLabel('Report period end')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate report drafts' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Recent Breach Alerts/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Vehicle Observations/ })).toHaveCount(0);
  expect(unscopedModuleRequests).toEqual([]);
  expect(scopedObservationFilters.length).toBeGreaterThan(0);
  expect(scopedObservationFilters.every((filter) => /(?:site_id|zone_id)\.in\./.test(filter))).toBe(true);
  expect(reportingRoots).toContain(OPERATING_ORG_ID);
});

test('administrator reviews and publishes a tenant report pack to the live client portal', async ({ page }, testInfo) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/reports');

  await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
  await expect(page.getByText('No report packs in this period')).toBeVisible();
  await page.getByRole('button', { name: 'Generate report drafts' }).click();

  await expect(page.getByText('1 report packs generated for the selected period.', { exact: true })).toBeVisible();
  const packs = page.getByRole('region', { name: 'Client report production (1)' });
  await expect(packs.getByText('Civic Events Compliance Services')).toBeVisible();
  await expect(packs.getByText('Needs review', { exact: true })).toBeVisible();
  const reportPackRegion = page.getByRole('region', { name: 'Report packs' });
  expect(await reportPackRegion.locator('thead th').first().evaluate((header) => getComputedStyle(header).position)).toBe('sticky');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if ((page.viewportSize()?.width ?? 0) < 760) {
    await expect(page.getByText('Scroll horizontally to review report status, PDF, and delivery actions.')).toBeVisible();
    expect(await reportPackRegion.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  }
  await expect(reportPackRegion).toHaveScreenshot('report-pack-review-table.png');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Civic Events Compliance Services' })).toBeVisible();
  await page.getByLabel('Client-facing title').fill('August service accountability report');
  await page.getByLabel('Executive summary').fill('All scheduled visits were completed and one incident was recorded.');
  await testInfo.attach('report-review-editor', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  await page.getByRole('button', { name: 'Publish reviewed report' }).click();
    await expect(page.getByText('Reviewed report published to Civic Events Compliance Services\'s live client portal.', { exact: true })).toBeVisible();
  await expect(packs.getByText('Live in portal', { exact: true })).toBeVisible();
  await expect(packs.getByText('Available in client portal', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
  await testInfo.attach('report-review-published', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
});

test('administrator builds a mixed-scope custom report and reviews the frozen snapshot', async ({ page }, testInfo) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/reports');

  await page.getByLabel('Agreement').selectOption('24242424-2424-4424-8424-242424242424');
  await page.getByRole('button', { name: 'Build custom report' }).click();
  await expect(page.getByRole('heading', { name: 'Build a governed report draft' })).toBeVisible();
  await expect(page.getByText('All agreement activity')).toBeVisible();

  await page.getByRole('checkbox', { name: /Civic Events Centre/ }).check();
  await page.getByRole('checkbox', { name: 'Civic Event Operations Zone' }).check();
  await page.getByRole('checkbox', { name: 'Casey Morgan' }).check();
  await page.getByRole('checkbox', { name: /FCM123/ }).check();
  await expect(page.getByText('4 scoped records')).toBeVisible();
  await expect(page.getByText(/private identity attributes are excluded/i)).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Incident register' })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Checkpoint visits' })).toBeDisabled();

  await page.getByLabel('Report title').fill('Selected people, vehicles, and places');
  await testInfo.attach('custom-report-builder', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  await page.getByRole('button', { name: 'Create review draft' }).click();

  await expect(page.getByText('Custom report draft created with 2 observations and 1 linked breaches.', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Client report production (1)' })).toBeVisible();
  await expect(page.getByText('Custom', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByRole('definition').filter({ hasText: 'Civic Events Centre' })).toBeVisible();
  await expect(page.getByRole('definition').filter({ hasText: 'Casey Morgan' })).toBeVisible();
  await expect(page.getByRole('definition').filter({ hasText: 'FCM123' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Frozen source detail' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Observations (1)' })).toBeVisible();
  await expect(page.getByText('Non-compliant · Follow-up required')).toBeVisible();
  await page.getByRole('button', { name: 'Publish reviewed report' }).click();
  await expect(page.getByText(/published to Civic Events Compliance Services/)).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});