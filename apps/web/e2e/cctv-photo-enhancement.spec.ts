import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const IMPORT_ID = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
const EVIDENCE_ID = '6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b';
const SIGNED_PATH = '/object/sign/bob-uploads/cctv/gate-photo.png?token=e2e';

test('zooming an evidence photo renders the enhanced view instead of silently skipping it', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'CCTV review is a desktop workflow.');
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { officerModules: ['cctv'] });

  const png = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#b8bcc0';
    context.fillRect(0, 0, 320, 180);
    context.fillStyle = '#9a9ea2';
    context.fillRect(100, 80, 120, 30);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });

  await page.route('**/rest/v1/cctv_imports*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{ id: IMPORT_ID, camera_label: 'Gate camera', camera_key: 'gate', status: 'ready', location_id: null, site_id: null, zone_id: null, source_timezone: 'Pacific/Auckland', source_device_kind: 'camera', recorded_from: '2026-10-18T04:42:58Z', recorded_to: '2026-10-18T04:42:59Z', video_count: 0, skipped_count: 0, snapshot_count: 1, created_at: '2026-10-18T05:00:00Z', locations: null }]),
  }));
  await page.route('**/rest/v1/rpc/get_cctv_console_import_detail', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ evidence: [{ id: EVIDENCE_ID, storage_path: 'cctv/gate-photo.png', captured_at: '2026-10-18T04:42:58Z', metadata: { file_name: 'gate-photo.png', file_type: 'image/png' }, sha256_hash: null, is_court_ready: false, locked_at: null, retention_hold: false }], jobs: [], synopses: [], marks: [], observations: [] }),
  }));
  await page.route('**/storage/v1/object/sign/**', (route) => route.request().method() === 'GET'
    ? route.fulfill({ status: 200, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: Buffer.from(png) })
    : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ signedURL: SIGNED_PATH }) }));

  await signInAsAdmin(page, '/admin/field-ops?area=cctv-console');
  const tile = page.locator('.cctv-tile').first();
  await expect(tile.locator('img.cctv-tile__video')).toHaveJSProperty('complete', true);
  await tile.click();
  await page.getByRole('button', { name: 'Zoom in' }).click();

  await expect(tile.locator('.cctv-tile__enhance-badge')).toContainText('Enhanced view');
  await expect(tile.locator('canvas.cctv-tile__enhanced.is-live')).toBeVisible();
  await expect.poll(() => tile.locator('canvas.cctv-tile__enhanced').evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBeGreaterThan(1);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});
