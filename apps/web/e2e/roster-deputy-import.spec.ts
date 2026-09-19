import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const OFFICER_ID = '22222222-2222-4222-8222-222222222222';

// Same 94-column header as the real Deputy export; synthetic people only.
const HEADER = ['Payroll ID', 'Display Name', 'Timesheet Date', 'Timesheet Start Time', 'Timesheet End Time', 'Timesheet Unpaid Break (Total)', 'Timesheet Total Time', 'Timesheet Cost', 'Timesheet Rest or Meal Break (Total)', 'Timesheet Unpaid Break (Scheduled)', 'Timesheet Unpaid Break (Duration Only)', 'Timesheet Rest or Meal Break (Scheduled)', 'Timesheet Rest or Meal Break (Duration Only)', 'Employee Comment', 'Time Approved', 'Is In Progress', 'Discarded', 'Is Leave', 'Pay Approved', 'Exported', 'Paid', 'Real Time', 'Auto Rounded', 'Auto Time Approved', 'Validation Flag', 'Timesheet Created', 'Timesheet Modified', 'First Name', 'Last Name', 'Date Of Birth', 'Gender', 'Employed', 'Start Date', 'Termination Date', 'Position', 'Employee Modified', 'Pay Center', 'Employee Export Code', 'Schedule Date', 'Schedule Start Time', 'Schedule End Time', 'Schedule Unpaid Break (Total)', 'Schedule Rest or Meal Break (Total)', 'Schedule Unpaid Break (Scheduled)', 'Schedule Rest or Meal Break (Scheduled)', 'Schedule Unpaid Break (Duration Only)', 'Schedule Rest or Meal Break (Duration Only)', 'Schedule Total Time', 'Schedule Cost', 'Schedule Warning', 'Schedule Notes', 'Schedule Published', 'Schedule Open', 'Schedule Created', 'Schedule Modified', 'Area Created', 'Area Modified', 'Area Name', 'Area Export Code', 'Location Code', 'Location Name', 'Roster Sort Order', 'Show On Roster', 'Time Start', 'Time End', 'Date Start', 'Date End', 'Days', 'Leave Comment', 'Leave Status', 'Leave Manager Comment', 'Total Hours', 'Leave Type Name', 'Leave Export Code', 'Paid Leave', 'Access Level Name', 'Stress Profile Name', 'Email', 'Phone', 'Code', 'Location Name', 'Active', 'Is Workplace', 'Is Pay Center', 'Company Created', 'Company Modified', 'Pay Period Name', 'Pay Period Active', 'Pay Period Start Date', 'Pay Period Cycle', 'REQ / RITM Number', 'Purchase Order', 'EMS Minutes', 'NCR Minutes'];
function row(values: Record<string, string>): string {
  const cells = HEADER.map(() => '');
  for (const [name, value] of Object.entries(values)) { const index = HEADER.indexOf(name); if (index >= 0) cells[index] = value; }
  return cells.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell)).join(',');
}
const CSV = [
  HEADER.join(','),
  row({ 'Display Name': '(N)PTL - Ana Ngata [900001]', 'Employee Export Code': '900001', 'Timesheet Date': '14/05/2026', 'Timesheet Start Time': '18:00', 'Timesheet End Time': '23:00', 'Is Leave': 'FALSE', 'Schedule Date': '14/05/2026', 'Schedule Start Time': '18:00', 'Schedule End Time': '23:00', 'Schedule Published': 'TRUE', 'Schedule Notes': 'Evening run. SRBA required.', 'Area Name': 'Patrols', 'Area Export Code': '356310000|MPP', 'Location Code': '6947', 'Location Name': 'NSN: 585 Day Patrol', 'REQ / RITM Number': 'na', 'Purchase Order': 'na', 'EMS Minutes': '0' }),
  row({ 'Display Name': '(N)PTL - Ana Ngata [900001]', 'Employee Export Code': '900001', 'Timesheet Date': '15/05/2026', 'Timesheet Start Time': '9:00', 'Timesheet End Time': '17:00', 'Is Leave': 'FALSE', 'Schedule Date': '15/05/2026', 'Schedule Start Time': '9:00', 'Schedule End Time': '17:00', 'Schedule Published': 'TRUE', 'Area Name': 'Call Centre Ord Time', 'Area Export Code': '300873001|NSC', 'Location Code': '2573', 'Location Name': 'NSC: After Hours Rosterer', 'EMS Minutes': '480' }),
  row({ 'Display Name': '(N)CAS - Unknown Person [900002]', 'Employee Export Code': '900002', 'Timesheet Date': '14/05/2026', 'Timesheet Start Time': '9:00', 'Timesheet End Time': '17:00', 'Is Leave': 'FALSE', 'Schedule Date': '14/05/2026', 'Schedule Start Time': '9:00', 'Schedule End Time': '17:00', 'Schedule Published': 'TRUE', 'Area Name': 'Ordinary Time', 'Area Export Code': '350369979|SGC1', 'Location Code': '839', 'Location Name': 'NSN: MOJ Nelson District Court', 'REQ / RITM Number': 'RITM0237298', 'Purchase Order': 'Nelson DC - 14/05/2026' }),
  row({ 'Display Name': '(N)PTL - Ana Ngata [900001]', 'Employee Export Code': '900001', 'Timesheet Date': '20/05/2026', 'Is Leave': 'TRUE', 'Date Start': '20/05/2026', 'Date End': '21/05/2026', 'Total Hours': '16', 'Leave Type Name': 'Annual Leave (Vacation)', 'Leave Status': 'Approved' }),
].join('\n');

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installSupabaseFixtures(page);
  // Staff only load for a branch-authorised operating context (same as roster-operations.spec).
  await page.route('**/rest/v1/rpc/get_operating_organization_contexts', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ organization_id: '41414141-4141-4141-8141-414141414141', organization_name: 'Northern Branch', authority_basis: 'branch_authorisation', role_at_branch: 'admin', module_access: ['roster'], can_be_rostered: false, is_default: true }]) }));
});

test('admin imports a Deputy export as draft shifts and leave through the four-step walkthrough', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  let payload: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/rpc/apply_deputy_roster_import', async (route) => {
    payload = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ batch_id: 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1', work_units_created: 1, work_units_matched: 0, people_matched: 1, slots_created: 1, slots_already_imported: 0, slots_unresolved: 0, leave_created: 1, leave_already_imported: 0, leave_unresolved: 0, timesheets_not_imported: 3 }) });
  });
  await signInAsAdmin(page, '/admin/roster');
  await page.getByRole('button', { name: 'Import from Deputy' }).click();
  const wizard = page.getByRole('dialog', { name: 'Import from Deputy' });
  await expect(wizard.getByRole('list', { name: 'Import steps' }).locator('li')).toHaveText(['1Files', '2People', '3Places', '4Review and import']);
  await expect(wizard).toContainText('Nothing is published, and no people are created.');
  await wizard.getByLabel('Deputy timesheet and schedule export').setInputFiles({ name: 'deputy-export.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV, 'utf8') });
  await wizard.getByRole('button', { name: 'Read the files' }).click();

  // People: exact-name match found for Ana; the unknown person stays unmatched with plain guidance.
  await expect(wizard).toContainText('4 rows');
  await expect(wizard.getByLabel('Staff member for Ana Ngata')).toHaveValue(OFFICER_ID);
  await expect(wizard.getByLabel('Staff member for Unknown Person')).toHaveValue('');
  await expect(wizard).toContainText('Nobody is created here');
  await wizard.getByRole('button', { name: 'Next: places' }).click();

  // Places: patrol and static are picked not created; internal work can be created.
  await expect(wizard.getByLabel('Action for NSN: 585 Day Patrol')).toHaveValue('skip');
  await expect(wizard).toContainText('Patrol runs come from a client agreement.');
  await expect(wizard.getByLabel('Action for NSC: After Hours Rosterer')).toHaveValue('create_internal');
  await expect(wizard.getByLabel('Action for NSN: MOJ Nelson District Court')).toHaveValue('skip');
  await expect(wizard).toHaveScreenshot('deputy-import-places.png');
  await wizard.getByRole('button', { name: 'Next: review' }).click();

  // Review: only the schedule whose person and place both resolved becomes a draft.
  await expect(wizard).toContainText('1 draft shifts will be created (1 are in the past and stay as history)');
  await expect(wizard).toContainText('1 schedules skipped: person not in your staff list');
  await expect(wizard).toContainText('1 schedules skipped: location skipped for now');
  await expect(wizard).toContainText('1 leave records will be created');
  await expect(wizard).toContainText('3 timesheet rows are counted in the batch but not turned into pay or attendance records yet.');
  await wizard.getByRole('button', { name: 'Import 1 draft shifts and 1 leave records' }).click();

  await expect(wizard.getByRole('status')).toContainText('Import recorded');
  await expect(wizard).toContainText('1 draft shifts created');
  await expect(wizard).toContainText('Next: the drafts are on the roster board.');
  expect(payload).toMatchObject({ p_operating_organization_id: '41414141-4141-4141-8141-414141414141', p_row_count: 4, p_source_file: 'deputy-export.csv' });
  const sent = payload as unknown as { p_slots: Array<Record<string, unknown>>; p_people: Array<Record<string, unknown>>; p_locations: Array<Record<string, unknown>>; p_leave: Array<Record<string, unknown>>; p_manifest: Record<string, unknown> };
  expect(sent.p_slots).toHaveLength(1);
  expect(sent.p_slots[0]).toMatchObject({ export_code: '900001', deputy_code: '2573', starts_at: '2026-05-15T09:00:00+12:00', ends_at: '2026-05-15T17:00:00+12:00', pay_code: 'NSC', ems_minutes: 480, purchase_order: null });
  expect(sent.p_people).toEqual(expect.arrayContaining([{ export_code: '900001', staff_id: OFFICER_ID }, { export_code: '900002', staff_id: null }]));
  expect(sent.p_locations.find((location) => location.deputy_code === '2573')).toMatchObject({ action: 'create_internal', service_type: 'call_centre' });
  expect(sent.p_locations.find((location) => location.deputy_code === '6947')).toMatchObject({ action: 'skip' });
  expect(sent.p_leave[0]).toMatchObject({ export_code: '900001', starts_on: '2026-05-20', ends_on: '2026-05-21', leave_type: 'annual', status: 'Approved' });
  expect(sent.p_manifest).toMatchObject({ timesheet_rows: 3, leave_rows: 1 });
  expect(JSON.stringify(payload)).not.toMatch(/Date Of Birth|Phone|Email/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
});
