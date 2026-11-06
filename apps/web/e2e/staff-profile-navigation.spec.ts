import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, signInAsAdmin } from './fixtures';

const base = process.env.PLAYWRIGHT_APP_BASE || '/';
const staffId = '22222222-2222-4222-8222-222222222222';
const profilePath = `${base}admin/people-hr`;

test('staff profile and record details stay in the main workspace and retain the application base', async ({ page }) => {
  await installSupabaseFixtures(page);
  const mutations: string[] = [];
  page.on('request', request => {
    if (request.url().includes('/rest/v1/') && ['POST', 'PATCH', 'DELETE'].includes(request.method())
        && !request.url().includes('/rpc/')) mutations.push(request.url());
  });
  await signInAsAdmin(page, `${profilePath}?tab=staff`);
  const staffRow = page.getByRole('row', { name: /Ana Ngata/ });
  await expect(staffRow).toBeVisible();

  await staffRow.getByRole('button', { name: 'Open profile ↗' }).click();
  await expect(page.getByRole('heading', { name: 'Ana Ngata', exact: true })).toBeVisible();
  const profileUrl = new URL(page.url());
  expect(profileUrl.pathname).toBe(profilePath);
  expect(profileUrl.searchParams.get('profile')).toBe(staffId);
  expect(profileUrl.searchParams.get('popout')).toBeNull();
  await page.getByRole('button', { name: 'Credentials', exact: true }).click();
  expect(new URL(page.url()).pathname).toBe(profilePath);
  expect(new URL(page.url()).searchParams.get('profileTab')).toBe('credentials');
  await page.reload();
  await expect(page.getByRole('button', { name: /Security licence \(PSPLA\)/ })).toBeVisible();

  await page.getByRole('button', { name: /Security licence \(PSPLA\)/ }).click();
  const recordUrl = new URL(page.url());
  expect(recordUrl.pathname).toBe(profilePath);
  expect(recordUrl.searchParams.get('profile')).toBe(staffId);
  expect(recordUrl.searchParams.get('recordKind')).toBe('credential');
  await expect(page.getByRole('complementary', { name: 'Selected record details' })).toContainText('SL-2048');
  await page.getByRole('link', { name: 'Back to staff directory' }).click();
  const workspaceUrl = new URL(page.url());
  expect(workspaceUrl.pathname).toBe(profilePath);
  expect(workspaceUrl.searchParams.get('profile')).toBeNull();
  expect(workspaceUrl.searchParams.get('popout')).toBeNull();
  await expect(page.getByRole('row', { name: /Ana Ngata/ })).toBeVisible();
  expect(mutations).toEqual([]);
});

test('unavailable staff stays an explicit permission/data state rather than a server 404', async ({ page }) => {
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/staff_profiles*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await signInAsAdmin(page, `${profilePath}?profile=${staffId}`);
  await expect(page.getByRole('alert')).toContainText('The staff profile is unavailable or you do not have permission to view it.');
  expect(new URL(page.url()).pathname).toBe(profilePath);
});
