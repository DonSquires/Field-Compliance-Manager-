import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-31T08:45:00+12:00'));
  await installSupabaseFixtures(page);
});

test('operations proposes, inspects and verifies a site boundary through the geofence workbench', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/sites');
  const notice = page.locator('.boundary-message.is-success');

  await expect(page.getByRole('heading', { name: 'Geofence workbench' })).toBeVisible();
  await expect(page.getByText('No geometry', { exact: true }).locator('..').getByText('1')).toBeVisible();
  await expect(page.getByText('Open proposals').locator('..').getByText('0')).toBeVisible();

  await page.getByRole('button', { name: /North Pavilion/ }).click();
  await expect(page.getByText('Geometry required')).toBeVisible();
  await expect(page.getByText('unresolved_no_geofence')).toBeVisible();
  await expect(page.getByLabel('Boundary map for North Pavilion')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Suggest boundary from LINZ' })).toBeEnabled();
  const queueFilters = page.getByRole('group', { name: 'Geofence queue filter' });
  const queueGeometry = await page.locator('.boundary-queue').evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  const queueWidth = await page.locator('.boundary-queue').evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(queueWidth.scrollWidth).toBeLessThanOrEqual(queueWidth.clientWidth + 1);
  await queueFilters.getByRole('button', { name: 'All', exact: true }).click();
  await expect(queueFilters.getByRole('button', { name: 'All', exact: true })).toHaveClass(/is-active/);
  await expect(page.getByLabel('Boundary map for North Pavilion')).toBeVisible();
  await queueFilters.getByRole('button', { name: 'Attention', exact: true }).click();

  // Places with a centre and no shape can be suggested in bulk; the batch only stages proposals.
  const batch = page.getByRole('region', { name: 'Suggest missing boundaries' });
  await expect(batch.getByText('nothing is verified automatically')).toBeVisible();
  await expect(batch.getByRole('button', { name: /Suggest \d+ from LINZ/ })).toBeEnabled();

  await page.getByRole('tab', { name: 'Point + radius' }).click();
  const propose = page.getByRole('region', { name: 'Propose a boundary' });
  await propose.getByLabel('Latitude', { exact: true }).fill('-41.2762');
  await propose.getByLabel('Longitude', { exact: true }).fill('173.2817');
  await propose.getByLabel('Radius in metres').fill('75');
  await page.getByRole('button', { name: 'Propose point-radius boundary' }).click();

  await expect(notice).toContainText('Point + radius (provisional) proposed for North Pavilion');
  await expect(page.getByText('Proposal awaiting decision')).toBeVisible();
  await expect(page.getByText('Open proposals').locator('..').getByText('1')).toBeVisible();
  await expect(page.getByText('Within band')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reject proposal' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Accept, verify later' })).toBeEnabled();

  await page.getByRole('button', { name: 'Checked on the map — accept and verify' }).click();
  await expect(notice).toContainText('verified from your map check');
  // The reviewer is moved on to the next place needing attention; reopen the verified site to inspect its record.
  await queueFilters.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('button', { name: /North Pavilion/ }).click();
  await expect(page.getByText('Verified boundary')).toBeVisible();
  await expect(page.getByText('provisional provenance')).toBeVisible();
  await expect(page.getByText('Boundary verified via visual map confirmation')).toBeVisible();
  await expect(page.getByText(/Accepted boundary proposal .* \(google_point_radius\)/)).toBeVisible();

  // Tier 4: a checkpoint is placed at the verified site, lands unverified, and is certified only by the map confirmation.
  const checkpoints = page.getByRole('region', { name: 'Checkpoints at this site' });
  await expect(checkpoints.getByText('No checkpoints at this site yet.')).toBeVisible();
  await checkpoints.getByLabel('Checkpoint name').fill('Gate A');
  await expect(checkpoints.getByRole('button', { name: 'Place checkpoint' })).toBeDisabled();
  await checkpoints.getByLabel('Checkpoint latitude').fill('-41.27615');
  await checkpoints.getByLabel('Checkpoint longitude').fill('173.28175');
  await checkpoints.getByRole('button', { name: 'Place checkpoint' }).click();
  await expect(notice).toContainText('Gate A placed (5 m, history v1). It is unverified until you confirm its position on the map.');
  await expect(checkpoints.getByText('Unverified', { exact: true })).toBeVisible();
  await expect(checkpoints.getByRole('button', { name: 'Verify checkpoint' })).toBeDisabled();
  await checkpoints.getByText('Position inspected on the map').click();
  await checkpoints.getByRole('button', { name: 'Verify checkpoint' }).click();
  await expect(notice).toContainText('Gate A verified from visual map review.');
  await expect(checkpoints.getByText('Verified', { exact: true })).toBeVisible();
  await checkpoints.scrollIntoViewIfNeeded();
  await expect(checkpoints).toHaveScreenshot('site-boundary-checkpoints.png');

  await page.getByRole('heading', { name: 'Geofence workbench' }).scrollIntoViewIfNeeded();
  await expect(page).toHaveScreenshot('site-boundary-review.png', { fullPage: true });
  expect(errors, errors.join('\n')).toEqual([]);
});
test('a reviewer can ask LINZ for every missing boundary at once and still decides each one on the map', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/sites');
  const batch = page.getByRole('region', { name: 'Suggest missing boundaries' });
  await batch.getByRole('button', { name: /Suggest \d+ from LINZ/ }).click();
  await expect(page.locator('.boundary-message.is-success')).toContainText(/LINZ suggested \d+ of \d+ boundaries/);
  await expect(batch.locator('.workbench-batch-report li.is-ok').first()).toContainText('Proposal staged');
  await expect(page.getByText('Open proposals').locator('..').getByText(/[1-9]/)).toBeVisible();
  await page.getByRole('button', { name: /North Pavilion/ }).click();
  await expect(page.getByText('Proposal awaiting decision')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Checked on the map — accept and verify' })).toBeEnabled();
  if (process.env.WORKBENCH_SHOTS) {
    await page.screenshot({ path: `${process.env.WORKBENCH_SHOTS}/workbench-desktop.png`, fullPage: true });
    await page.getByRole('region', { name: 'Open boundary proposal' }).screenshot({ path: `${process.env.WORKBENCH_SHOTS}/decision-desktop.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('region', { name: 'Open boundary proposal' }).screenshot({ path: `${process.env.WORKBENCH_SHOTS}/decision-mobile.png` });
  }
  expect(errors, errors.join('\n')).toEqual([]);
});