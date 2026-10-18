import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, signInAsOfficer } from './fixtures';

test('page feedback captures safe context and submits only a review brief', async ({ page }) => {
  await installOfficerScheduleFixtures(page);
  await page.route('**/rest/v1/bob_friction_packets**', (route) => route.fulfill({ json: [] }));
  let body: { client_packet_key: string; envelope: { before: { page: string }; during: { user_report: { desired_behavior: string } } } } | null = null;
  await page.route('**/functions/v1/bob-triage-report', async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({ json: { packet_id: 'request-123', triage: 'ux_gap', route: 'self_heal_apparatus',
      repair_risk: 'significant', automation_status: 'awaiting_grandmaster', stop_line_hit: null } });
  });
  await signInAsOfficer(page);
  const path = new URL(page.url()).pathname;
  await page.getByRole('button', { name: 'Request change', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Request a change to this page' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('not a code change or permission to build');
  await dialog.getByLabel(/Before/).fill('I need to scroll to see my next assigned shift.');
  await dialog.getByLabel(/After/).fill('Keep the next assigned shift above the history list.');
  await dialog.getByLabel('Why does it matter?').fill('Officers can find their next task faster.');
  await dialog.getByRole('button', { name: 'Send to review queue' }).click();
  await expect(dialog).toContainText('Request recorded');
  expect(body!.envelope.before.page).toBe(path);
  expect(body!.client_packet_key).toMatch(/^change:/);
  expect(body!.envelope.during.user_report.desired_behavior).toContain('next assigned shift');
  const size = await dialog.boundingBox();
  expect(size!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Request change', exact: true })).toBeFocused();
});
