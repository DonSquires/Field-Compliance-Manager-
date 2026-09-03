import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installOfficerScheduleFixtures(page);
});

test('officer noise assessment captures the evidence-package measurement and source fields', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await page.route('**/rest/v1/noise_assessments**', async (route) => {
    if (route.request().method() === 'POST') {
      const [payload] = JSON.parse(route.request().postData() ?? '[]');
      expect(payload).toMatchObject({
        noise_source: 'Amplified music',
        noise_source_address: '65 Tipahi Street, Nelson South',
        volume_score: 3,
        time_score: 1,
        tone_score: 2,
        matrix_total: 6,
        action_taken: 'direction_notice',
        hs_checklist_completed: true,
      });
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'abababab-abab-4bab-8bab-abababababab', ...payload, prior_notice_count: 0, assessed_at: '2026-08-30T09:30:00.000Z', review_status: 'open', reviewed_at: null, review_notes: null, follow_up_required: false }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await signInAsOfficer(page, '/officer/noise_control');
  await page.getByRole('button', { name: /New Assessment/ }).click();
  await page.getByLabel('Noise source', { exact: true }).fill('Amplified music');
  await page.getByLabel('Noise source address').fill('65 Tipahi Street, Nelson South');
  await page.getByLabel('Volume score').selectOption('3');
  await page.getByLabel('Bass / tone score').selectOption('2');
  await page.getByLabel('Scene description').fill('Music is plainly audible at the street boundary.');
  await page.getByLabel('Action taken').selectOption('direction_notice');
  await expect(page.getByRole('button', { name: 'Submit Assessment' })).toBeDisabled();
  await page.getByText('H&S pre-visit check completed', { exact: true }).click();
  await page.getByRole('button', { name: 'Submit Assessment' }).click();

  await expect(page.getByText('Amplified music', { exact: true })).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});