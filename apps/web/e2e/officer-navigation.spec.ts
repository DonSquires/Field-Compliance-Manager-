import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, installSupabaseFixtures, signInAsAdmin, signInAsOfficer } from './fixtures';

test('officer can reach Home, Schedule and Tools with usable phone targets', async ({ page }, testInfo) => {
  if (testInfo.project.name.includes('mobile')) await page.setViewportSize({ width: 320, height: 740 });
  await installOfficerScheduleFixtures(page);
  await signInAsOfficer(page, '/officer');

  const bar = page.getByRole('navigation', { name: 'Field actions' });
  for (const name of ['Home', 'Schedule', 'Tools', 'Report', 'SOS']) {
    const button = bar.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    const bounds = await button.boundingBox();
    expect(bounds?.width, `${name} target width`).toBeGreaterThanOrEqual(44);
    expect(bounds?.height, `${name} target height`).toBeGreaterThanOrEqual(44);
    expect(await button.evaluate((element) => element.scrollWidth <= element.clientWidth), `${name} label fits`).toBe(true);
  }
  if (testInfo.project.name.includes('mobile')) {
    for (const selector of ['.notification-trigger', '.officer-profile-chip', '.officer-more-tools', '.officer-safety-chip']) {
      const bounds = await page.locator(selector).boundingBox();
      expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 320, `${selector} is on screen`).toBe(true);
      expect(bounds?.width, `${selector} target width`).toBeGreaterThanOrEqual(44);
      expect(bounds?.height, `${selector} target height`).toBeGreaterThanOrEqual(44);
    }
    await page.locator('.notification-trigger').click();
    const notifications = page.locator('.notification-panel');
    await expect(notifications).toBeVisible();
    const panel = await notifications.boundingBox();
    expect(panel && panel.x >= 0 && panel.x + panel.width <= 320).toBe(true);
    await notifications.getByRole('button', { name: 'Close notifications' }).click();
    const moreTools = page.getByRole('button', { name: 'More field tools' });
    await moreTools.click();
    await expect(page.getByRole('button', { name: 'Open Bob command center' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Open instructions/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(moreTools).toBeFocused();
    await expect(moreTools).toHaveAttribute('aria-expanded', 'false');
  }
  await bar.getByRole('button', { name: 'Schedule' }).focus();
  await page.keyboard.press('Tab');
  await expect(bar.getByRole('button', { name: 'Tools' })).toBeFocused();
  expect(await bar.getByRole('button', { name: 'Tools' }).evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('solid');
  await page.screenshot({ path: testInfo.outputPath('officer-home.png') });
  const more = page.locator('.officer-home-more');
  await expect(more).not.toHaveAttribute('open', '');
  await expect(page.getByRole('button', { name: 'Check in now' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Operational brief' })).toBeHidden();
  await more.locator('summary').click();
  await expect(page.getByRole('heading', { name: 'Operational brief' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Vehicle lookup/ })).toBeVisible();

  await bar.getByRole('button', { name: 'Schedule' }).click();
  await expect(page).toHaveURL(/\/officer\/schedule$/);
  await expect(page.getByRole('heading', { name: 'My schedule' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('officer-schedule.png') });
  await expect(bar.getByRole('button', { name: 'Schedule' })).toHaveAttribute('aria-current', 'page');
  const unscheduled = page.locator('.officer-ad-hoc-shift');
  await expect(unscheduled).not.toHaveAttribute('open', '');
  await unscheduled.locator('summary').click();
  await expect(page.getByLabel('Work unit', { exact: true })).toBeVisible();

  await bar.getByRole('button', { name: 'Home' }).click();
  await expect(page).toHaveURL(/\/officer$/);
  await expect(bar.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  await bar.getByRole('button', { name: 'Tools' }).click();
  await expect(page.getByRole('heading', { name: 'Tools' })).toBeVisible();
  await bar.getByRole('button', { name: 'Home' }).click();
  await expect(page).toHaveURL(/\/officer$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('dual-role users can switch between portals without signing out', async ({ page }) => {
  await installSupabaseFixtures(page, { adminRole: 'admin_officer' });
  await signInAsAdmin(page, '/admin');
  await page.getByRole('button', { name: /Admin Portal/ }).click();
  await page.getByLabel('Account and workspace tools').click();
  await page.getByRole('button', { name: 'Switch to field portal' }).click();
  await expect(page).toHaveURL(/\/officer$/);
  await page.getByRole('button', { name: 'Account settings' }).click();
  await page.getByRole('button', { name: 'Switch to admin portal' }).click();
  await expect(page).toHaveURL(/\/admin$/);
});

test('unsaved reports survive a cancelled Home action without delaying SOS', async ({ page }) => {
  await installOfficerScheduleFixtures(page);
  let sosRequests = 0;
  await page.route('**/rest/v1/rpc/raise_officer_welfare_alert', async (route) => {
    sosRequests += 1;
    await route.fulfill({ json: { alert_id: 'sos-fixture', triggered_at: '2026-08-31T12:00:00Z' } });
  });
  await signInAsOfficer(page, '/officer/report');
  await page.getByLabel('Report title').fill('An unfinished report');
  await page.getByLabel('Report description').fill('Notes still being written by the officer.');
  let warning = '';
  page.once('dialog', async (dialog) => { warning = dialog.message(); await dialog.dismiss(); });
  await page.getByRole('navigation', { name: 'Field actions' }).getByRole('button', { name: 'Home' }).click();
  expect(warning).toContain('unsubmitted field work');
  await expect(page).toHaveURL(/\/officer\/report$/);
  await expect(page.getByLabel('Report description')).toHaveValue('Notes still being written by the officer.');
  await page.getByRole('navigation', { name: 'Field actions' }).getByRole('button', { name: 'SOS', exact: true }).click();
  await expect.poll(() => sosRequests).toBe(1);
  await expect(page.getByLabel('Report title')).toHaveValue('An unfinished report');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('navigation', { name: 'Field actions' }).getByRole('button', { name: 'Home' }).click();
  await expect(page).toHaveURL(/\/officer$/);
});

test('a debrief remains when Home navigation is cancelled', async ({ page }) => {
  await installOfficerScheduleFixtures(page);
  await signInAsOfficer(page, '/officer/debrief');
  const summary = page.getByLabel('Operational summary');
  await summary.fill('This unfinished handover must stay on the page.');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('navigation', { name: 'Field actions' }).getByRole('button', { name: 'Home' }).click();
  await expect(summary).toHaveValue('This unfinished handover must stay on the page.');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('navigation', { name: 'Field actions' }).getByRole('button', { name: 'Home' }).click();
  await expect(page).toHaveURL(/\/officer$/);
});

test('cancelling navigation from an unread notification does not mark it read', async ({ page }) => {
  await installOfficerScheduleFixtures(page);
  let marks = 0;
  await page.route('**/rest/v1/notifications**', async (route) => {
    if (route.request().method() === 'PATCH') {
      marks += 1;
      return route.fulfill({ json: [{ id: '16161616-1616-4616-8616-161616161616' }] });
    }
    return route.fulfill({ json: [{
      id: '16161616-1616-4616-8616-161616161616', category: 'roster', severity: 'warning',
      title: 'Roster assignment updated', body: 'Your shift has changed.', link_page: 'schedule',
      link_payload: { shift_id: '66666666-6666-4666-8666-666666666666' }, read_at: null,
      created_at: '2026-08-30T09:20:00Z',
    }] });
  });
  await signInAsOfficer(page, '/officer/report');
  await page.getByLabel('Report title').fill('Unfinished report');
  await page.locator('.notification-trigger').click();
  const panel = page.getByRole('region', { name: 'Notifications' });
  page.once('dialog', (confirmation) => confirmation.dismiss());
  await panel.getByRole('button', { name: /Roster assignment updated/ }).click();
  expect(marks).toBe(0);
  await expect(page.getByLabel('Report title')).toHaveValue('Unfinished report');
  await expect(panel).toBeVisible();
  page.once('dialog', (confirmation) => confirmation.accept());
  await panel.getByRole('button', { name: /Roster assignment updated/ }).click();
  await expect(page).toHaveURL(/\/officer\/schedule/);
  expect(marks).toBe(1);
});

test('ending a shift protects unfinished debrief text when closing or opening stops', async ({ page }) => {
  await installOfficerScheduleFixtures(page);
  const active = {
    id: '12121212-1212-4212-8212-121212121212', organization_id: '11111111-1111-4111-8111-111111111111',
    officer_user_id: '22222222-2222-4222-8222-222222222222', service_type: 'patrol',
    scheduled_start: '2026-08-29T20:00:00Z', scheduled_end: '2026-08-30T04:00:00Z',
    status: 'in_progress', patrol_route_id: null, shift_stops: [], total_stops: 1,
    created_at: '2026-08-29T19:00:00Z', updated_at: '2026-08-29T20:00:00Z',
  };
  await page.route('**/rest/v1/shifts**', (route) => route.fulfill({ json: [active] }));
  await page.route('**/rest/v1/rpc/get_shift_end_readiness', (route) => route.fulfill({ json: {
    shift_id: active.id, status: 'in_progress', service_type: 'patrol', scheduled_end: active.scheduled_end, actual_start: null,
    open_stops: [{ stop_id: 'stop-1', place: 'Test place', status: 'pending', module_key: null }],
    open_stop_count: 1, open_required_task_count: 0, open_dispatch_job_count: 0,
    active_welfare_alert_count: 0, debrief_submitted: false, blockers: ['One stop remains open'],
    can_end: false, can_end_after_debrief: false,
  } }));
  await signInAsOfficer(page, '/officer/schedule');
  await page.getByRole('button', { name: 'End shift' }).click();
  const dialog = page.getByRole('dialog', { name: 'End patrol shift' });
  const summary = dialog.getByLabel('How did the shift go?');
  await summary.fill('Handover in progress.');
  page.once('dialog', (confirmation) => confirmation.dismiss());
  await dialog.getByRole('button', { name: 'Not yet' }).click();
  await expect(summary).toHaveValue('Handover in progress.');
  page.once('dialog', (confirmation) => confirmation.dismiss());
  await dialog.getByRole('button', { name: 'Open stops' }).click();
  await expect(summary).toHaveValue('Handover in progress.');
  page.once('dialog', (confirmation) => confirmation.accept());
  await dialog.getByRole('button', { name: 'Open stops' }).click();
  await expect(page).toHaveURL(/\/officer\/patrol$/);
});
