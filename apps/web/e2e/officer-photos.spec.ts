import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, signInAsOfficer } from './fixtures';

test('officer can choose a phone photo and confirm its exact saved report attachment', async ({ page }) => {
  const reportId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const organizationId = '33333333-3333-4333-8333-333333333333';
  const shiftId = '66666666-6666-4666-8666-666666666666';
  await installOfficerScheduleFixtures(page);
  await page.route('**/rest/v1/rpc/officer_photo_target_context', async (route) => {
    expect(route.request().postDataJSON().p_record_id).toBe(reportId);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ organization_id: organizationId, shift_id: shiftId }]) });
  });
  let uploaded = false;
  await page.route('**/storage/v1/object/**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    expect(route.request().method()).toBe('POST');
    expect(route.request().url()).toContain(`/officer-photos/`);
    uploaded = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"Key":"synthetic-private-upload"}' });
  });
  let registered = false;
  await page.route('**/rest/v1/rpc/attach_officer_record_photo', async (route) => {
    const args = route.request().postDataJSON();
    expect(uploaded).toBe(true);
    expect(args.p_record_id).toBe(reportId);
    expect(args.p_original_name).toBe('synthetic-evidence.png');
    expect(args.p_sha256).toMatch(/^[a-f0-9]{64}$/);
    registered = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      attachment_id: '98989898-9898-4898-8898-989898989898', evidence_id: '97979797-9797-4979-8979-979797979797',
      record_kind: args.p_record_kind, record_id: reportId, organization_id: organizationId, shift_id: shiftId,
      sha256: args.p_sha256, storage_path: `org/${organizationId}/officer-photos/${args.p_record_kind}/${reportId}/${args.p_sha256}`,
      privacy_review_status: 'pending',
    }) });
  });
  await signInAsOfficer(page, '/officer/report');
  const target = page.getByRole('combobox', { name: 'Photo attachment target' });
  await expect(target).toBeVisible();
  await expect(target.locator('option')).toHaveCount(2);
  await target.selectOption({ index: 1 });
  await page.getByLabel('Choose evidence photos from gallery').setInputFiles({
    name: 'synthetic-evidence.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64'),
  });
  await page.getByRole('button', { name: 'Upload / retry unconfirmed photos' }).click();
  await expect(page.getByText('Confirmed — private, pending review')).toBeVisible();
  expect(registered).toBe(true);
});
