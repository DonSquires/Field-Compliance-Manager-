import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-31T10:00:00+12:00'));
  await installSupabaseFixtures(page);
});

test('provider configures covered sites and service modules through the accepted agreement', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/relationships');

  const relationship = page.getByText('Civic Events Compliance Services', { exact: true }).locator('..').locator('..').locator('..');
  await relationship.getByRole('button', { name: 'Configure agreement' }).click();
  const dialog = page.getByRole('dialog', { name: 'Civic Events Compliance Services' });
  await expect(dialog.getByText('Civic Events Limited · accepted agreement')).toBeVisible();
  await expect(dialog.getByText('Verified authoritative boundary')).toBeVisible();
  await expect(dialog.getByText('North Pavilion')).toBeVisible();
  await dialog.getByText('North Pavilion').locator('..').locator('..').getByRole('button', { name: 'Add coverage' }).click();
  await expect(dialog.getByRole('status')).toContainText('Covered site linked');
  await expect(dialog.getByRole('button', { name: /Covered places 2/ })).toBeVisible();

  await dialog.getByRole('button', { name: /Service modules/ }).click();
  const parking = dialog.getByRole('article', { name: 'Module parking enforcement' });
  await parking.getByText('Enabled', { exact: true }).click();
  await parking.getByLabel('SLA minutes').fill('45');
  await parking.getByText('Client submission', { exact: true }).click();
  await parking.getByRole('button', { name: 'Save module' }).click();
  await expect(dialog.getByRole('status')).toContainText('Service module settings saved');
  await expect(dialog.getByRole('button', { name: /Service modules 2/ })).toBeVisible();

  await dialog.getByRole('button', { name: /Covered places/ }).click();
  await expect(dialog).toHaveScreenshot('crm-agreement-setup.png');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('provider reviews evidence-backed readiness and opens the owning workflow', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/relationships');

  const relationship = page.getByText('Civic Events Compliance Services', { exact: true }).locator('..').locator('..').locator('..');
  await relationship.getByRole('button', { name: 'Review readiness' }).click();
  const dialog = page.getByRole('dialog', { name: 'Civic Events Compliance Services' });
  await expect(dialog.getByText('2 readiness blockers')).toBeVisible();
  await expect(dialog.getByRole('article', { name: 'Commercial rates ready' })).toContainText('positive agreement or covered-place rate');
  await expect(dialog.getByRole('article', { name: 'Operational work ready' })).toContainText('1 active attributed work unit');
  await expect(dialog.getByRole('article', { name: 'Boundary evidence blocked' })).toContainText('authoritative verified geometry');
  await expect(dialog.getByRole('article', { name: 'Reporting delivery blocked' })).toContainText('without a valid monthly template');
  await expect(dialog).not.toContainText('%');
  await expect(dialog).toHaveScreenshot('crm-operational-readiness.png');

  await dialog.getByRole('article', { name: 'Boundary evidence blocked' }).getByRole('button', { name: 'Open owner' }).click();
  await expect(page.getByRole('heading', { name: 'Geofence workbench' })).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('provider governs measurable contract requirements without implying automatic work', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/relationships');

  const relationship = page.getByText('Civic Events Compliance Services', { exact: true }).locator('..').locator('..').locator('..');
  await relationship.getByRole('button', { name: 'Configure agreement' }).click();
  const dialog = page.getByRole('dialog', { name: 'Civic Events Compliance Services' });
  await dialog.getByRole('button', { name: /Requirements 0/ }).click();

  await expect(dialog.getByText(/do not create shifts, patrol stops, reports, notifications, or officer post orders/i)).toBeVisible();
  await dialog.getByRole('button', { name: 'Add requirement' }).click();
  await dialog.getByLabel('Requirement code').fill('PATROL.DAILY');
  await dialog.getByLabel('Requirement type').selectOption('patrol_frequency');
  await expect(dialog.getByText('It does not create roster work or patrol stops.')).toBeVisible();
  await dialog.getByLabel('Covered Site').selectOption('42424242-4242-4242-8242-424242424242');
  await dialog.getByLabel('Minimum patrols').fill('2');
  await dialog.getByLabel('Cadence').selectOption('day');
  await dialog.getByLabel('Requirement description').fill('Complete two documented patrols during each contracted day.');
  await dialog.getByText('Evidence is required').click();
  await dialog.getByLabel('Required evidence').selectOption('gps_track');
  await dialog.getByLabel('Escalate after, minutes').fill('30');
  await dialog.getByRole('button', { name: 'Save requirement' }).click();

  await expect(dialog.getByRole('status')).toContainText('Contract requirement added with an audit receipt');
  const requirement = dialog.getByRole('article', { name: 'PATROL.DAILY active' });
  await expect(requirement).toContainText('2 per day');
  await expect(requirement).toContainText('GPS track proof required');
  await expect(dialog.getByRole('button', { name: /Requirements 1/ })).toBeVisible();

  await requirement.getByRole('button', { name: 'Deactivate' }).click();
  await expect(requirement.getByRole('button', { name: 'Confirm deactivate' })).toBeVisible();
  await requirement.getByRole('button', { name: 'Cancel' }).click();
  await expect(requirement.getByRole('button', { name: 'Deactivate' })).toBeVisible();
  await requirement.getByRole('button', { name: 'Deactivate' }).click();
  await requirement.getByRole('button', { name: 'Confirm deactivate' }).click();
  await expect(dialog.getByRole('article', { name: 'PATROL.DAILY inactive' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Requirements 0/ })).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('provider reviews, links, and withdraws contract evidence without erasing history', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/relationships');

  const relationship = page.getByText('Civic Events Compliance Services', { exact: true }).locator('..').locator('..').locator('..');
  await relationship.getByRole('button', { name: 'Configure agreement' }).click();
  const dialog = page.getByRole('dialog', { name: 'Civic Events Compliance Services' });
  await dialog.getByRole('button', { name: /Requirements 0/ }).click();

  await dialog.getByRole('button', { name: 'Add requirement' }).click();
  await dialog.getByLabel('Requirement code').fill('CHECK.ENTRY');
  await dialog.getByLabel('Requirement type').selectOption('compliance_check');
  await dialog.getByLabel('Covered Site').selectOption('42424242-4242-4242-8242-424242424242');
  await dialog.getByLabel('Requirement description').fill('Record a verified attendance timestamp for the entry check.');
  await dialog.getByText('Evidence is required').click();
  await dialog.getByLabel('Required evidence').selectOption('timestamp');
  await dialog.getByRole('button', { name: 'Save requirement' }).click();

  const requirement = dialog.getByRole('article', { name: 'CHECK.ENTRY active' });
  await requirement.getByRole('button', { name: 'Evidence register' }).click();
  const evidence = requirement.getByRole('region', { name: 'CHECK.ENTRY evidence register' });
  await expect(evidence.getByText('Source check ready')).toBeVisible();
  await expect(evidence.getByText('Server-recorded arrival and departure')).toBeVisible();
  await expect(evidence).toContainText('Ana Ngata');

  await evidence.getByLabel('Review note (optional)').fill('Reviewed against the contracted entry check.');
  await evidence.getByRole('button', { name: 'Link evidence' }).click();
  await expect(evidence.getByRole('status')).toContainText('Evidence linked with a review receipt');
  await expect(evidence.getByRole('heading', { name: /Linked evidence/ })).toContainText('1 active');
  await expect(evidence.getByText('Completed stop timestamp')).toBeVisible();
  await expect(evidence.getByText('No unlinked completed work currently satisfies')).toBeVisible();

  await evidence.getByRole('button', { name: 'Withdraw link' }).click();
  await evidence.getByLabel('Why is this link incorrect?').fill('Linked to the wrong contract requirement.');
  await evidence.getByRole('button', { name: 'Confirm withdrawal' }).click();
  await expect(evidence.getByRole('status')).toContainText('Evidence link withdrawn');
  await expect(evidence.getByText(/Withdrawn by Morgan Reed/)).toContainText('Linked to the wrong contract requirement.');
  await expect(evidence.getByRole('heading', { name: /Linked evidence/ })).toContainText('0 active');
  expect(errors, errors.join('\n')).toEqual([]);
});