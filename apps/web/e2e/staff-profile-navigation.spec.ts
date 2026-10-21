import { expect, test, type Page } from '@playwright/test';
import { installSupabaseFixtures, signInAsAdmin } from './fixtures';

const base = process.env.PLAYWRIGHT_APP_BASE || '/';
const staffId = '22222222-2222-4222-8222-222222222222';
const profilePath = `${base}admin/people-hr`;

async function followPopup(page: Page, click: () => Promise<void>): Promise<URL> {
  const pending = page.waitForEvent('popup');
  await click();
  const popup = await pending;
  await popup.waitForURL(/\/admin\/people-hr\?/);
  const url = new URL(popup.url());
  expect(url.pathname).toBe(profilePath);
  await popup.close();
  const response = await page.goto(url.toString());
  expect(response?.status()).toBe(200);
  return url;
}

test('staff profile, evidence popouts and return link retain the application base and staff context', async ({ page }) => {
  await installSupabaseFixtures(page);
  const mutations: string[] = [];
  page.on('request', request => {
    if (request.url().includes('/rest/v1/') && ['POST', 'PATCH', 'DELETE'].includes(request.method())
        && !request.url().includes('/rpc/')) mutations.push(request.url());
  });
  await signInAsAdmin(page, `${profilePath}?tab=staff`);
  const staffRow = page.getByRole('row', { name: /Ana Ngata/ });
  await expect(staffRow).toBeVisible();

  const profileUrl = await followPopup(page, () => staffRow.getByRole('button', { name: 'Open profile ↗' }).click());
  expect(profileUrl.searchParams.get('profile')).toBe(staffId);
  expect(profileUrl.searchParams.get('popout')).toBe('1');
  await expect(page.getByRole('heading', { name: 'Ana Ngata', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Credentials', exact: true }).click();
  expect(new URL(page.url()).pathname).toBe(profilePath);
  expect(new URL(page.url()).searchParams.get('profileTab')).toBe('credentials');
  await page.reload();
  await expect(page.getByRole('button', { name: /Security licence \(PSPLA\)/ })).toBeVisible();

  const recordUrl = await followPopup(page, () => page.getByRole('button', { name: /Security licence \(PSPLA\)/ }).click());
  expect(recordUrl.searchParams.get('profile')).toBe(staffId);
  expect(recordUrl.searchParams.get('recordKind')).toBe('credential');
  await expect(page.getByRole('complementary', { name: 'Selected record details' })).toContainText('SL-2048');
  const workspaceUrl = await followPopup(page, () => page.getByRole('link', { name: 'Open main workspace' }).click());
  expect(workspaceUrl.searchParams.get('profile')).toBeNull();
  expect(workspaceUrl.searchParams.get('popout')).toBeNull();
  await expect(page.getByRole('row', { name: /Ana Ngata/ })).toBeVisible();
  expect(mutations).toEqual([]);
});

test('unavailable staff stays an explicit permission/data state rather than a server 404', async ({ page }) => {
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/staff_profiles*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await signInAsAdmin(page, `${profilePath}?profile=${staffId}&popout=1`);
  await expect(page.getByRole('alert')).toContainText('The staff profile is unavailable or you do not have permission to view it.');
  expect(new URL(page.url()).pathname).toBe(profilePath);
});
