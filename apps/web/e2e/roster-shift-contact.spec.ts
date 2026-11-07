import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, signInAsAdmin } from './fixtures';

const officerId = '22222222-2222-4222-8222-222222222222';
const staticUnit = '20202020-2020-4020-8020-202020202020';
const patrolUnit = '18181818-1818-4818-8818-181818181818';
const slotId = '32323232-3232-4232-8232-323232323232';
const version = '99999999-9999-4999-8999-999999999999';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-31T09:30:00+12:00'));
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/rpc/get_operating_organization_contexts', async (route) => route.fulfill({
    json: [{ organization_id: '41414141-4141-4141-8141-414141414141', organization_name: 'Northern Branch', authority_basis: 'branch_authorisation', role_at_branch: 'admin', module_access: ['roster'], can_be_rostered: false, is_default: true }],
  }));
});

test('creates a static shift with a designated contact and safely retries a lost response', async ({ page }) => {
  const attempts: Array<Record<string, unknown>> = [];
  let materializations = 0;
  await page.route('**/rest/v1/rpc/create_static_roster_slot_with_contact', async (route) => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) return route.fulfill({ status: 503, json: { message: 'Temporary save problem' } });
    return route.fulfill({ json: { id: slotId, status: 'published' } });
  });
  await page.route('**/rest/v1/rpc/materialize_roster_slot', async (route) => {
    materializations += 1;
    return route.fulfill({ status: 500, json: { message: 'Publishing materialises on the server' } });
  });
  await signInAsAdmin(page, '/admin/roster');
  await page.getByRole('button', { name: /Create shift/ }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Create shift' });
  await dialog.getByLabel('Work unit').selectOption(staticUnit);
  await dialog.getByLabel('Officer', { exact: true }).selectOption(officerId);
  await dialog.getByLabel('Start', { exact: true }).fill('2026-09-01T10:00');
  await dialog.getByLabel('End', { exact: true }).fill('2026-09-01T18:00');
  await dialog.getByLabel('Contact person').fill('Synthetic duty contact');
  await dialog.getByLabel('Contact phone').fill('12');
  await dialog.getByRole('button', { name: 'Create shift' }).click();
  await expect(dialog.getByText('Enter a valid contact phone number, including any extension.')).toBeVisible();
  expect(attempts).toHaveLength(0);
  await dialog.getByLabel('Contact phone').fill('+64 (0)3 555 1234 ext. 21');
  await dialog.getByRole('button', { name: 'Create shift' }).click();
  await expect(dialog.getByText('Temporary save problem')).toBeVisible();
  await dialog.getByRole('button', { name: 'Create shift' }).click();
  await expect(page.getByText(/Shift published for Ana Ngata/)).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toMatchObject({ p_work_unit_id: staticUnit, p_staff_id: officerId, p_contact_name: 'Synthetic duty contact', p_contact_phone: '+64 (0)3 555 1234 ext. 21', p_publish: true });
  expect(attempts[0].p_client_request_id).toEqual(attempts[1].p_client_request_id);
  expect(attempts[0]).toHaveProperty('p_planned_break_minutes');
  expect(materializations).toBe(0);
});

test('updates and clears the contact on a published static shift', async ({ page }) => {
  let contact: { contact_name: string | null; contact_phone: string | null; version: string } | null = {
    contact_name: 'Initial contact', contact_phone: '03 555 1234', version,
  };
  const saves: Array<Record<string, unknown>> = [];
  await page.route('**/rest/v1/roster_slots*', async (route) => route.fulfill({ json: [{
    id: slotId, work_unit_id: staticUnit, staff_id: officerId, scheduled_start: '2026-09-01T08:00:00.000Z',
    scheduled_end: '2026-09-01T16:00:00.000Z', status: 'published', linked_shift_id: null, notes: null, contact,
  }] }));
  await page.route('**/rest/v1/rpc/set_roster_slot_contact', async (route) => {
    const body = route.request().postDataJSON();
    saves.push(body);
    if (body.p_expected_version !== contact?.version) return route.fulfill({ status: 409, json: { message: 'Shift contact changed. Refresh the roster before saving' } });
    contact = body.p_contact_name || body.p_contact_phone
      ? { contact_name: body.p_contact_name, contact_phone: body.p_contact_phone, version: '88888888-8888-4888-8888-888888888888' }
      : null;
    return route.fulfill({ json: { roster_slot_id: slotId, changed: true } });
  });
  await signInAsAdmin(page, '/admin/roster');
  await page.locator('.roster-operational-dock > summary').click();
  await page.locator('.roster-slot-queue').getByRole('button', { name: /Civic Centre Static Post/ }).click();
  const inspector = page.locator('.roster-slot-inspector');
  await expect(inspector.getByText('Initial contact · 03 555 1234')).toBeVisible();
  await inspector.getByRole('button', { name: 'Edit shift contact' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit shift contact' });
  await dialog.getByLabel('Contact person').fill('Updated duty contact');
  await dialog.getByLabel('Contact phone').fill('');
  await dialog.getByRole('button', { name: 'Save contact' }).click();
  await expect(inspector.getByText('Updated duty contact')).toBeVisible();
  expect(saves[0]).toMatchObject({ p_slot_id: slotId, p_expected_status: 'published', p_contact_name: 'Updated duty contact', p_contact_phone: null, p_expected_version: version });
  await inspector.getByRole('button', { name: 'Edit shift contact' }).click();
  await dialog.getByLabel('Contact person').fill('');
  await dialog.getByRole('button', { name: 'Save contact' }).click();
  await expect(inspector.getByText('Not designated')).toBeVisible();
  expect(saves[1]).toMatchObject({ p_contact_name: null, p_contact_phone: null, p_expected_version: '88888888-8888-4888-8888-888888888888' });
});

test('edits a draft shift and its contact atomically with a version check', async ({ page }) => {
  let contact = { contact_name: 'Draft contact', contact_phone: '03 555 1234', version };
  let saved: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/roster_slots*', async (route) => route.fulfill({ json: [{
    id: slotId, work_unit_id: staticUnit, staff_id: officerId, scheduled_start: '2026-09-01T08:00:00.000Z',
    scheduled_end: '2026-09-01T16:00:00.000Z', status: 'draft', linked_shift_id: null, notes: null, contact,
  }] }));
  await page.route('**/rest/v1/rpc/update_static_roster_slot_with_contact', async (route) => {
    saved = route.request().postDataJSON();
    contact = { contact_name: String(saved!.p_contact_name), contact_phone: String(saved!.p_contact_phone), version: '88888888-8888-4888-8888-888888888888' };
    return route.fulfill({ json: { id: slotId, status: 'draft' } });
  });
  await signInAsAdmin(page, '/admin/roster');
  await page.locator('.roster-operational-dock > summary').click();
  await page.locator('.roster-slot-queue').getByRole('button', { name: /Civic Centre Static Post/ }).click();
  await page.locator('.roster-slot-inspector').getByRole('button', { name: 'Edit draft' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit draft shift' });
  await expect(dialog.getByLabel('Work unit')).toBeDisabled();
  await dialog.getByLabel('Contact person').fill('Revised duty contact');
  await dialog.getByLabel('Briefing notes').fill('Synthetic operational instructions.');
  await dialog.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft roster slot updated. Review it before publishing.')).toBeVisible();
  expect(saved).toMatchObject({
    p_slot_id: slotId, p_expected_status: 'draft', p_staff_id: officerId,
    p_contact_name: 'Revised duty contact', p_contact_phone: '03 555 1234',
    p_expected_contact_version: version, p_notes: 'Synthetic operational instructions.',
  });
});

test('requires review of copied contacts and warns that bulk repeats omit them', async ({ page }) => {
  let creates = 0;
  await page.route('**/rest/v1/roster_slots*', async (route) => route.fulfill({ json: [{
    id: slotId, work_unit_id: staticUnit, staff_id: officerId, scheduled_start: '2026-09-01T08:00:00.000Z',
    scheduled_end: '2026-09-01T16:00:00.000Z', status: 'published', linked_shift_id: null, notes: null,
    contact: { contact_name: 'Initial contact', contact_phone: '03 555 1234', version },
  }] }));
  await page.route('**/rest/v1/rpc/create_static_roster_slot_with_contact', async (route) => {
    creates += 1;
    return route.fulfill({ json: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'draft' } });
  });
  await signInAsAdmin(page, '/admin/roster');
  await page.locator('.roster-operational-dock > summary').click();
  await page.locator('.roster-slot-queue').getByRole('button', { name: /Civic Centre Static Post/ }).click();
  const inspector = page.locator('.roster-slot-inspector');
  await inspector.getByRole('button', { name: 'Repeat selected' }).click();
  const repeat = page.getByRole('dialog', { name: 'Repeat assignment' });
  await expect(repeat.getByText(/Shift contacts are not copied/)).toBeVisible();
  await repeat.getByRole('button', { name: 'Cancel' }).click();
  await inspector.getByRole('button', { name: 'Copy selected' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create shift' });
  await expect(dialog.getByLabel('Contact person')).toHaveValue('Initial contact');
  await dialog.getByRole('button', { name: 'Create shift' }).click();
  await expect(dialog.getByText('Confirm the copied contact is correct for this shift.')).toBeVisible();
  expect(creates).toBe(0);
  await dialog.getByLabel('I confirmed this contact for the new shift.').check();
  await dialog.getByRole('button', { name: 'Create shift' }).click();
  await expect(page.getByText(/Shift copied as a draft/)).toBeVisible();
  expect(creates).toBe(1);
  await page.locator('.roster-slot-queue').getByRole('button', { name: /Civic Centre Static Post/ }).click();
  await inspector.getByRole('button', { name: 'Copy selected' }).click();
  await dialog.getByLabel('Work unit').selectOption(patrolUnit);
  await dialog.getByLabel('Work unit').selectOption(staticUnit);
  await expect(dialog.getByLabel('Contact person')).toHaveValue('');
  await expect(dialog.getByLabel('Contact phone')).toHaveValue('');
});
