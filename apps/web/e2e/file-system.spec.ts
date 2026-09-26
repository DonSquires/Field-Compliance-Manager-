import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installSupabaseFixtures(page);
});

test('administrator searches, reviews, and opens a source document', async ({ page }, testInfo) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/files');
  await expect(page.getByRole('heading', { name: 'File system' })).toBeVisible();
  await expect(page.getByText('sample-data-2026-09-08')).toHaveCount(0);
  await expect(page.getByText('Vehicle Log (1).csv')).toHaveCount(0);
  const importTools = page.locator('details.file-system-import-tools');
  await expect(importTools).not.toHaveAttribute('open', '');
  await expect(page.getByText('Choose CSV/XLSX', { exact: true })).toBeHidden();
  await importTools.locator('summary').click();
  await expect(importTools).toHaveAttribute('open', '');
  await expect(page.getByText('Choose CSV/XLSX', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create import batch for review' })).toHaveCount(0);
  await importTools.locator('summary').click();
  await expect(importTools).not.toHaveAttribute('open', '');
  await expect(page.getByRole('heading', { name: 'Files waiting registration' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Approved document artifacts' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Issued notice artifacts' })).toHaveCount(0);
  await page.getByRole('button', { name: 'File space: Generated outputs' }).click();
  await expect(page.getByRole('heading', { name: 'Approved document artifacts' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Issued notice artifacts' })).toBeVisible();
  await page.getByRole('button', { name: 'File space: All files' }).click();
  await expect(page.getByText('Quarantined: Unsupported or unsafe artifact')).toBeVisible();
  await page.getByRole('button', { name: 'Register in Files' }).click();
  await expect(page.getByRole('status')).toContainText('registered into the Files workspace');
  await expect(page.getByRole('heading', { name: '107 Gorge Road - Service Agreement.pdf' })).toBeVisible();
  await page.getByPlaceholder('Search filenames, type, source, or hash').fill('Gorge Road');
  await expect(page.getByRole('heading', { name: '1 files' })).toBeVisible();
  await page.getByRole('button', { name: 'File space: Contracts', exact: true }).click();
  await expect(page.getByText('94% extraction confidence')).toBeVisible();
  await expect(page.getByText('Service agreement for contracted security services at 107 Gorge Road.')).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __openedFile?: string }).__openedFile = '';
    window.open = ((url?: string | URL) => {
      (window as unknown as { __openedFile?: string }).__openedFile = String(url ?? '');
      return null;
    }) as typeof window.open;
  });
  await page.getByRole('button', { name: 'Open source' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __openedFile?: string }).__openedFile)).toContain('signed/sample-document.pdf');
  await page.screenshot({ path: testInfo.outputPath('files-registry.png'), fullPage: true });
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('administrator creates an import review batch only from a selected file', async ({ page }) => {
  let batchPayload: Record<string, unknown> = {};
  await page.route('**/rest/v1/rpc/create_file_import_batch', async (route) => {
    batchPayload = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'abababab-abab-4bab-8bab-ababababab45' }) });
  });
  await signInAsAdmin(page, '/admin/files');
  const importTools = page.locator('details.file-system-import-tools');
  await importTools.locator('summary').click();
  await page.getByLabel('Upload import CSV or XLSX').setInputFiles({
    name: 'current-vehicle-observations.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('REGO,RecordedDate\nABC123,2026-08-30T09:00:00+12:00\n'),
  });
  await expect(page.getByText('current-vehicle-observations.csv', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create import batch for review' })).toBeVisible();
  await page.getByRole('button', { name: 'Create import batch for review' }).click();
  await expect(page.getByRole('status')).toContainText('Review batch abababab created. No canonical records were changed.');
  expect(batchPayload).toMatchObject({ p_source_file: 'current-vehicle-observations.csv', p_row_count: 1, p_organization_id: '41414141-4141-4141-8141-414141414141' });
  expect(String(batchPayload.p_source_sha256)).toMatch(/^[a-f0-9]{64}$/);
});