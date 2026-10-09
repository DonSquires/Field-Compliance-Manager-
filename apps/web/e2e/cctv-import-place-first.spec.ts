import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test('CCTV import keeps place selection first and does not start before the manifest is ready', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  const importWriteCalls: string[] = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (/\/rest\/v1\/rpc\/(create_cctv_import|set_cctv_import_manifest|register_cctv_import_(video|photo)|record_cctv_device_events)$/.test(pathname)) {
      importWriteCalls.push(pathname);
    }
  });
  await installSupabaseFixtures(page, { officerModules: ['cctv'] });
  await signInAsAdmin(page, '/admin/field-ops?area=cctv-import');

  const workspace = page.locator('.cctv-import-page');
  await expect(workspace).toBeVisible();
  await expect(workspace.locator('.cctv-import-layout > section h2')).toHaveText([
    'Where is this camera?',
    'Camera',
    'Folder',
    'Start',
  ]);

  const placeSearch = page.getByRole('searchbox', { name: 'Search sites and zones' });
  await expect(placeSearch).toBeVisible();
  const placeOption = page.getByRole('option', { name: /Civic Events House/ });
  await expect(placeOption).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start import' })).toBeDisabled();
  await expect(page).toHaveScreenshot('cctv-import-place-first-viewport.png');

  const viewport = page.viewportSize();
  const searchBounds = await placeSearch.boundingBox();
  if ((viewport?.width ?? 0) <= 760) {
    expect(searchBounds && viewport && searchBounds.y + searchBounds.height <= viewport.height - 70).toBe(true);
  }

  await placeOption.click();
  await expect(placeOption).toHaveAttribute('aria-selected', 'true');
  await expect(workspace.getByText('Place chosen')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start import' })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(importWriteCalls).toEqual([]);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});