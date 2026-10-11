import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installOfficerScheduleFixtures(page);
});

test('officer noise assessment captures the evidence-package measurement and source fields', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  let submittedNoise: Record<string, unknown> | null = null;

  await page.route('**/rest/v1/rpc/submit_officer_noise_assessment', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    expect(payload).toMatchObject({
      p_noise_source: 'Amplified music',
      p_noise_source_address: '65 Tipahi Street, Nelson South',
      p_volume_score: 3,
      p_time_score: 1,
      p_tone_score: 2,
      p_action_taken: 'verbal_warning',
    });
    submittedNoise = {
      id: 'abababab-abab-4bab-8bab-abababababab',
      noise_source: 'Amplified music',
      decibel_reading: null,
      prior_notice_count: 0,
      action_taken: 'verbal_warning',
      scene_description: 'Music is plainly audible at the street boundary.',
      assessed_at: '2026-08-30T09:30:00.000Z',
      review_status: 'open',
      reviewed_at: null,
      review_notes: null,
      follow_up_required: false,
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'abababab-abab-4bab-8bab-abababababab', matrix_total: 6, review_status: 'open' }]),
    });
  });

  await page.route('**/rest/v1/noise_assessments**', async (route) => {
    const list = submittedNoise ? [submittedNoise] : [];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(list) });
  });

  await signInAsOfficer(page, '/officer/noise_control');
  await page.getByRole('button', { name: /Officer-initiated assessment/ }).click();
  await page.getByLabel('Noise source', { exact: true }).fill('Amplified music');
  await page.getByLabel('Noise source address').fill('65 Tipahi Street, Nelson South');
  await page.getByLabel('Volume score').selectOption('3');
  await page.getByLabel('Bass / tone score').selectOption('2');
  await page.getByLabel('Scene description').fill('Music is plainly audible at the street boundary.');
  await page.getByLabel('Action taken').selectOption('verbal_warning');
  await expect(page.getByRole('button', { name: 'Submit Assessment' })).toBeDisabled();
  await page.getByText('H&S pre-visit check completed', { exact: true }).click();
  await page.getByRole('button', { name: 'Submit Assessment' }).click();

  await expect(page.getByText('Amplified music', { exact: true })).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});