import { expect, test } from '@playwright/test';

test('a guest can submit a dispute after choosing grounds and receives a confirmation', async ({ page }) => {
  let submissions = 0;
  let payload: Record<string, unknown> | null = null;
  await page.route('**/functions/v1/submit-dispute', async (route) => {
    submissions += 1;
    payload = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, dispute_id: 'dispute-e2e-001' }) });
  });

  await page.goto('/dispute');
  await expect(page.getByRole('heading', { name: 'Submit a dispute' })).toBeVisible();
  await page.getByLabel('Full name').fill('Test claimant');
  await page.getByLabel('Notice number').fill('NOTICE-E2E-001');
  await page.getByLabel('Statement').fill('The notice details do not match the vehicle.');
  await expect(page.getByRole('button', { name: 'Submit dispute' })).toBeDisabled();
  expect(submissions).toBe(0);

  await page.getByLabel('Incorrect notice details').check();
  await page.getByRole('button', { name: 'Submit dispute' }).click();
  await expect(page.getByRole('heading', { name: 'Dispute received' })).toBeVisible();
  expect(submissions).toBe(1);
  expect(payload).toMatchObject({
    notice_number: 'NOTICE-E2E-001',
    dispute_type: 'infringement',
    submitter_name: 'Test claimant',
    grounds: ['Incorrect notice details'],
    statement: 'The notice details do not match the vehicle.',
  });
  if ((page.viewportSize()?.width ?? 0) <= 760) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});
