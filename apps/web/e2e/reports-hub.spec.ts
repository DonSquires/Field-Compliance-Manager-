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

test('administrator previews the client site activity report with incidents, photos, the site log and the completeness check', async ({ page }, testInfo) => {
  const browserErrors = monitorBrowserErrors(page);
  const lineReads: string[] = [];
  const signedBatches: string[][] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/monthly_report_packs')) lineReads.push(url.searchParams.get('select') ?? '');
    if (request.method() === 'POST' && url.pathname.includes('/storage/v1/object/sign/')) signedBatches.push((request.postDataJSON() as { paths: string[] }).paths);
  });
  await signInAsAdmin(page, '/admin/reports');
  await page.getByRole('button', { name: 'Generate report drafts' }).click();
  await expect(page.getByText('1 report packs generated for the selected period.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review', exact: true }).click();

  const report = page.getByRole('region', { name: 'Site activity report' });
  await expect(report.getByText('Client report preview')).toBeVisible();
  const glance = report.getByRole('group', { name: 'Report at a glance' });
  await expect(glance.getByText('Pest culls recorded')).toBeVisible();
  await expect(glance).not.toContainText(/hour|km|travel|distance/i);
  await expect(page.getByText(/Patrol travel|Work hours/)).toHaveCount(0);
  await expect(report.getByRole('region', { name: 'Entries by type of activity' }).getByText('Manufacture and fabrication')).toBeVisible();

  const incidents = report.getByRole('region', { name: 'Incidents and investigations' });
  const incident = incidents.locator('article', { hasText: 'Vandalism' });
  await expect(incident.getByText('INV-2026-031 · Open')).toBeVisible();
  await expect(incident.getByText('Medium severity')).toBeVisible();
  await expect(incident.locator('img')).toHaveCount(2);
  await expect.poll(() => incident.locator('img').evaluateAll((images: HTMLImageElement[]) => images.every((image) => image.complete && image.naturalWidth > 0))).toBe(true);
  expect(lineReads.filter((select) => select === 'activity_lines,updated_at')).toHaveLength(1);
  expect(signedBatches).toEqual([['e2e/incidents/graffiti-1.jpg', 'e2e/incidents/graffiti-2.jpg']]);
  await page.mouse.move(0, 0);
  await expect(glance).toHaveScreenshot('report-site-activity-glance.png');
  await expect(incidents).toHaveScreenshot('report-site-activity-incidents.png');

  const opener = incident.getByRole('button', { name: 'Open photo 1 of 2' });
  await opener.click();
  const viewer = page.getByRole('dialog', { name: 'Photo 1 of 2' });
  await expect(viewer.getByText('Vandalism · Civic Events Centre · Sun 2 Aug 2026 · 22:15')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('dialog', { name: 'Photo 2 of 2' })).toBeVisible();
  await testInfo.attach('report-photo-viewer', { body: await page.screenshot(), contentType: 'image/png' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(opener).toBeFocused();

  await report.locator('summary', { hasText: /^Pest control/ }).click();
  await expect(report.getByRole('region', { name: 'Pest control by species' }).getByText('Feral goat')).toBeVisible();

  await report.locator('summary', { hasText: /^Site log/ }).click();
  const log = report.locator('details', { has: page.locator('summary', { hasText: /^Site log/ }) });
  await expect(log.getByRole('status')).toHaveText('5 entries with comments, work or photos');
  await expect(log.getByRole('heading', { name: 'Civic Events Centre' })).toBeVisible();
  await expect(log.getByText('1 routine patrol with nothing further to report (20 Aug).')).toBeVisible();
  await expect(log.getByText('Ref WO-0042')).toBeVisible();
  await expect(log.getByText('Ammunition .223 × 12')).toBeVisible();
  await expect(log.getByText('Vandalism')).toHaveCount(0);
  await log.getByLabel('Type of activity').selectOption('maintenance');
  await expect(log.getByRole('status')).toHaveText('1 entry matches these filters');
  await expect(log.getByText('Hinge replaced and the gate tested.')).toBeVisible();
  await log.getByRole('button', { name: 'Clear filters' }).click();
  await log.getByRole('checkbox', { name: 'With photos only' }).check();
  await expect(log.getByRole('status')).toHaveText('2 entries match these filters');
  await expect(log.locator('img')).toHaveCount(2);
  await log.getByRole('button', { name: 'Clear filters' }).click();
  expect(lineReads.filter((select) => select === 'activity_lines,updated_at')).toHaveLength(1);
  await testInfo.attach('report-site-activity-preview', { body: await page.screenshot(), contentType: 'image/png' });

  const check = report.locator('details', { has: page.locator('summary', { hasText: /^Completeness check/ }) });
  await expect(check.locator('summary')).toContainText('Provider only · All 9 records accounted for');
  await check.locator('summary').click();
  await expect(check.getByText('1 travel or administration record is kept out of the client report.')).toBeVisible();
  await check.getByRole('button', { name: 'Check against live records' }).click();
  await expect(check.getByText(/This pack matches live records: 7 entries/)).toBeVisible();
  await expect(check.getByRole('region', { name: 'Source files' }).getByText('Civic patrol log August.xlsx')).toBeVisible();
  await expect(check.getByRole('region', { name: 'Unlinked places with client records' }).getByText('Harbour Overflow Carpark')).toBeVisible();
  await expect(check.getByRole('button', { name: 'Check again' })).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('administrator can retry an unavailable report photo in context', async ({ page }, testInfo) => {
  const browserErrors = monitorBrowserErrors(page);
  let unavailable = true;
  await page.route('**/storage/v1/object/sign/scans/e2e/incidents/graffiti-1.jpg?*', async (route) => {
    if (unavailable) {
      await route.fulfill({ status: 200, contentType: 'image/jpeg', headers: { 'cache-control': 'no-store' }, body: 'invalid image fixture' });
    } else {
      await route.fallback();
    }
  });
  await signInAsAdmin(page, '/admin/reports');
  await page.getByRole('button', { name: 'Generate report drafts' }).click();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  const incident = page.getByRole('region', { name: 'Incidents and investigations' }).locator('article', { hasText: 'Vandalism' });
  await incident.scrollIntoViewIfNeeded();
  await expect(incident.getByRole('status')).toHaveText('1 photo could not be loaded. Open it to retry.');
  await incident.getByRole('button', { name: 'Photo 1 unavailable. Open to retry' }).click();
  const viewer = page.getByRole('dialog', { name: 'Photo 1 of 2' });
  await expect(viewer.getByRole('status')).toContainText('This photo could not be loaded.');
  await expect(viewer.getByText('Vandalism · Civic Events Centre · Sun 2 Aug 2026 · 22:15')).toBeVisible();
  await testInfo.attach('report-photo-retry', { body: await page.screenshot(), contentType: 'image/png' });
  unavailable = false;
  await viewer.getByRole('button', { name: 'Retry photo' }).click();
  await expect.poll(() => viewer.getByRole('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(viewer.getByRole('status')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(incident.getByRole('button', { name: 'Open photo 1 of 2' })).toBeFocused();
  await expect(incident.getByRole('status')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('administrator cannot mix activity from a newer report snapshot', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await page.route('**/rest/v1/monthly_report_packs?*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('select') !== 'activity_lines,updated_at') {
      await route.fallback();
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      updated_at: '2026-08-31T09:30:00.000Z',
      activity_lines: { version: 2, lines: [{ d: '2026-08-01', p: 'New place', k: 'incident', c: 'incident', it: 'trespass', n: 'NEW-SNAPSHOT' }] },
    }) });
  });
  await page.route('**/rest/v1/rpc/get_report_pack_activity_accounting', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ version: 1, packUpdatedAt: '2026-08-31T09:30:00.000Z', freshness: { hasFrozenReport: true, matchesLive: true, liveEntries: 7 } }),
  }));
  await signInAsAdmin(page, '/admin/reports');
  await page.getByRole('button', { name: 'Generate report drafts' }).click();
  await expect(page.getByText('1 report packs generated for the selected period.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  const report = page.getByRole('region', { name: 'Site activity report' });
  await expect(report.getByRole('region', { name: 'Incidents and investigations' }).getByText(/This report pack changed since you opened it/)).toBeVisible();
  await expect(report.getByText('NEW-SNAPSHOT')).toHaveCount(0);
  const check = report.locator('details', { has: page.locator('summary', { hasText: /^Completeness check/ }) });
  await check.locator('summary').click();
  await check.getByRole('button', { name: 'Check against live records' }).click();
  await expect(check.getByText(/This report pack changed since you opened it/)).toBeVisible();
  await expect(report.getByText(/This pack matches live records/)).toHaveCount(0);
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