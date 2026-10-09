import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const organizationId = '33333333-3333-4333-8333-333333333333';
const jobs = [
  { id: 'a1a1a1a1-0000-4000-8000-000000000001', evidence_item_id: 'b1b1b1b1-0000-4000-8000-000000000001', organization_id: organizationId, domain: 'video_motion', status: 'complete', stage: 'complete', created_at: '2026-08-30T09:00:00.000Z' },
  { id: 'a2a2a2a2-0000-4000-8000-000000000002', evidence_item_id: 'b2b2b2b2-0000-4000-8000-000000000002', organization_id: organizationId, domain: 'video_motion', status: 'complete', stage: 'complete', created_at: '2026-08-30T08:00:00.000Z' },
];

test('CCTV evidence search remains available and filters the authorized queue on mobile', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { officerModules: ['cctv'] });
  let jobQuery = '';
  await page.route('**/rest/v1/inference_jobs**', async (route) => {
    jobQuery = new URL(route.request().url()).search;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(jobs) });
  });
  await page.route('**/rest/v1/evidence_items**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { id: jobs[0].evidence_item_id, storage_path: 'cctv/north-yard-2026-08-30.h265', evidence_kind: 'video', metadata: { file_name: 'north-yard-2026-08-30.h265', file_type: 'video/h265', site_name: 'North Yard' } },
      { id: jobs[1].evidence_item_id, storage_path: 'cctv/south-gate-2026-08-30.h265', evidence_kind: 'video', metadata: { file_name: 'south-gate-2026-08-30.h265', file_type: 'video/h265', site_name: 'South Gate' } },
    ]) });
  });
  await page.route('**/rest/v1/rpc/cctv_inference_usage', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ daily_frame_budget: 1000, budget_is_default: true, budget_reason: null, frames_used_today: 120, exhausted: false, deferred_jobs: 0, days: [] }) });
  });

  await signInAsAdmin(page, '/admin/field-ops?area=cctv-review');
  const review = page.locator('.cctv-review-page');
  await expect(review).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Find CCTV evidence' });
  await expect(search).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) <= 760) {
    const bounds = await search.boundingBox();
    const viewport = page.viewportSize();
    expect(bounds && viewport && bounds.y + bounds.height <= viewport.height - 70).toBe(true);
  }
  const queue = page.getByRole('region', { name: 'CCTV review jobs' });
  await expect(queue.getByText('north-yard-2026-08-30.h265')).toBeVisible();
  await expect(queue.getByText('south-gate-2026-08-30.h265')).toBeVisible();
  expect(jobQuery).toContain(`organization_id=eq.${organizationId}`);
  await expect(page).toHaveScreenshot('cctv-review-queue-first-viewport.png');

  await search.fill('north-yard');
  await expect(queue.getByText('north-yard-2026-08-30.h265')).toBeVisible();
  await expect(queue.getByText('south-gate-2026-08-30.h265')).toHaveCount(0);
  await expect(queue.locator('.cctv-job-row')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});