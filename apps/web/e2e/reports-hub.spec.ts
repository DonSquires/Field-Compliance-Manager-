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

test('administrator reviews month-end activity, itemised lines and the live accounting check', async ({ page }, testInfo) => {
  const browserErrors = monitorBrowserErrors(page);
  const lineReads: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/monthly_report_packs')) lineReads.push(url.searchParams.get('select') ?? '');
  });
  await signInAsAdmin(page, '/admin/reports');
  await page.getByRole('button', { name: 'Generate report drafts' }).click();
  await expect(page.getByText('1 report packs generated for the selected period.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review', exact: true }).click();

  const activity = page.getByRole('region', { name: 'Month-end activity' });
  await expect(activity.getByText('All 5 entries accounted for')).toBeVisible();
  const totals = activity.getByRole('group', { name: 'Month-end activity totals' });
  await expect(totals.getByText('4.25', { exact: true })).toBeVisible();
  await expect(activity.getByRole('region', { name: 'Activity by category' }).getByText('Pest control')).toBeVisible();
  expect(lineReads.filter((select) => select.includes('activity_lines'))).toEqual([]);

  await activity.locator('summary', { hasText: /^Pest control/ }).click();
  await expect(activity.getByRole('region', { name: 'Pest control by species' }).getByText('Feral goat')).toBeVisible();

  await activity.locator('summary', { hasText: 'Itemised activity' }).click();
  const lines = activity.getByRole('region', { name: 'Itemised activity lines' });
  await expect(lines.getByText('WO-0042')).toBeVisible();
  await expect(lines.getByText('Shooting · Feral goat · Ammunition .223 × 12 · 1 photo')).toBeVisible();
  await activity.getByLabel('Category', { exact: true }).selectOption('maintenance');
  await expect(activity.getByText('Showing 1 of 1')).toBeVisible();
  await expect(lines.getByText('WO-0042')).toHaveCount(0);
  expect(lineReads.filter((select) => select === 'activity_lines,updated_at')).toHaveLength(1);

  await activity.getByRole('button', { name: 'Check against live records' }).click();
  await expect(activity.getByText(/This pack matches live records: 5 entries/)).toBeVisible();
  await expect(activity.getByRole('region', { name: 'Import source files' }).getByText('Civic patrol log August.xlsx')).toBeVisible();
  await expect(activity.getByRole('region', { name: 'Unlinked places with client records' }).getByText('Harbour Overflow Carpark')).toBeVisible();
  await expect(activity.getByRole('button', { name: 'Check again' })).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
  await testInfo.attach('report-month-end-activity', { body: await activity.screenshot(), contentType: 'image/png' });
});

test('administrator cannot mix activity from a newer report snapshot', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/reports');
  await page.getByRole('button', { name: 'Generate report drafts' }).click();
  await expect(page.getByText('1 report packs generated for the selected period.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.route('**/rest/v1/monthly_report_packs?*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('select') !== 'activity_lines,updated_at') {
      await route.fallback();
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      updated_at: '2026-08-31T09:30:00.000Z',
      activity_lines: { version: 1, lines: [{ d: '2026-08-01', p: 'New place', k: 'event', c: 'maintenance', j: 'NEW-SNAPSHOT' }] },
    }) });
  });
  await page.route('**/rest/v1/rpc/get_report_pack_activity_accounting', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ version: 1, packUpdatedAt: '2026-08-31T09:30:00.000Z', freshness: { hasFrozenReport: true, matchesLive: true, liveEntries: 5 } }),
  }));
  const activity = page.getByRole('region', { name: 'Month-end activity' });
  await activity.locator('summary', { hasText: 'Itemised activity' }).click();
  await expect(activity.getByText(/This report pack changed since you opened it/)).toBeVisible();
  await expect(activity.getByText('NEW-SNAPSHOT')).toHaveCount(0);
  await activity.getByRole('button', { name: 'Check against live records' }).click();
  await expect(activity.getByText(/This report pack changed since you opened it/)).toHaveCount(2);
  await expect(activity.getByText(/This pack matches live records/)).toHaveCount(0);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
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