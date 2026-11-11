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

test('administrator verifies an unverified credential from its record panel', async ({ page }) => {
  await installSupabaseFixtures(page);
  const credentialId = '36363636-3636-4636-8636-363636363636';
  const credential: Record<string, unknown> = { id: credentialId, credential_type: 'certificate_of_authority', credential_number: '25-127518', issuing_authority: 'Private Security Personnel Licensing Authority', issued_date: null, expiry_date: '2030-05-19', verified: false, verified_at: null, notes: 'Imported as unverified evidence from Staff COA Sheet.' };
  const payloads: Array<Record<string, unknown>> = [];
  await page.route('**/rest/v1/staff_credentials*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([credential]) }));
  await page.route('**/rest/v1/rpc/verify_staff_credential*', async route => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    payloads.push(payload);
    Object.assign(credential, { verified: true, verified_at: '2026-08-29T12:00:00.000Z', issued_date: payload.p_issued_date });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ credential_id: credentialId, staff_id: staffId, verified: true, verified_at: credential.verified_at, replayed: false }]) });
  });
  await signInAsAdmin(page, `${profilePath}?profile=${staffId}&profileTab=credentials&recordKind=credential&record=${credentialId}`);

  const panel = page.getByRole('complementary', { name: 'Selected record details' });
  await expect(panel).toContainText('Certificate of authority');
  await panel.getByRole('button', { name: 'Verify credential' }).click();
  const dialog = page.getByRole('dialog', { name: 'Verify credential' });
  await expect(dialog.getByLabel('Credential number')).toHaveValue('25-127518');
  await expect(dialog.getByLabel('Issuing authority')).toHaveValue('Private Security Personnel Licensing Authority');
  await expect(dialog.getByRole('button', { name: 'Confirm verification' })).toBeDisabled();
  await dialog.getByLabel('Issue date').fill('2025-05-19');
  await dialog.getByLabel('What you checked (10+ characters)').fill('COA checked against the PSPLA public register');
  await dialog.getByRole('button', { name: 'Confirm verification' }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText('credential verified and audited.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Verify credential' })).toHaveCount(0);
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toMatchObject({ p_credential_id: credentialId, p_credential_number: '25-127518', p_issued_date: '2025-05-19', p_expiry_date: '2030-05-19', p_evidence_notes: 'COA checked against the PSPLA public register' });
  expect(typeof payloads[0].p_client_request_id).toBe('string');
});

test('unavailable staff stays an explicit permission/data state rather than a server 404', async ({ page }) => {
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/staff_profiles*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await signInAsAdmin(page, `${profilePath}?profile=${staffId}`);
  await expect(page.getByRole('alert')).toContainText('The staff profile is unavailable or you do not have permission to view it.');
  expect(new URL(page.url()).pathname).toBe(profilePath);
});

test('staff profile shows the app sign-in state and keeps email actions on the profile', async ({ page }) => {
  await installSupabaseFixtures(page);
  await signInAsAdmin(page, `${profilePath}?profile=${staffId}`);
  await expect(page.getByRole('heading', { name: 'Ana Ngata', exact: true })).toBeVisible();
  const signIn = page.getByRole('form', { name: 'App sign-in' });
  await expect(signIn.getByTestId('staff-sign-in-state')).toContainText('Signed in');
  await expect(signIn.getByRole('button', { name: 'Update sign-in email' })).toBeDisabled();
  await expect(signIn.getByRole('button', { name: 'Resend invitation' })).toHaveCount(0);
  if (process.env.E2E_VISUAL_DIR) { await signIn.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${process.env.E2E_VISUAL_DIR}/staff-sign-in-${test.info().project.name}.png` }); }
});
