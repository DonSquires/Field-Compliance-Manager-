import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installSupabaseFixtures(page);
});

test('administrator searches, reviews, and opens a source document', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/files');
  await expect(page.getByRole('heading', { name: 'File system' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Files waiting registration' })).toBeVisible();
  await expect(page.getByText('Quarantined: Unsupported or unsafe artifact')).toBeVisible();
  await page.getByRole('button', { name: 'Register in Files' }).click();
  await expect(page.getByRole('status')).toContainText('registered into the Files workspace');
  await expect(page.getByRole('heading', { name: '107 Gorge Road - Service Agreement.pdf' })).toBeVisible();
  await page.getByPlaceholder('Search filenames, type, source, or hash').fill('Gorge Road');
  await expect(page.getByRole('heading', { name: '1 files' })).toBeVisible();
  await page.getByRole('button', { name: 'Contracts', exact: true }).click();
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
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});