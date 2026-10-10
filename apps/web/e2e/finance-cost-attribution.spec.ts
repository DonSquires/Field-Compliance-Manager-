import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const organizationId = '33333333-3333-4333-8333-333333333333';
const agreementId = '24242424-2424-4424-8424-242424242424';
const otherAgreementId = '35353535-3535-4535-8535-353535353535';
const shiftId = '56565656-5656-4656-8656-565656565656';
const unlinkedShiftId = '58585858-5858-4858-8858-585858585858';
const workUnitId = '18181818-1818-4818-8818-181818181818';
const agreementLocationId = '21212121-2121-4121-8121-212121212121';

test('manual labour cost follows the selected shift agreement and requires a real source', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  const costRequests: Record<string, unknown>[] = [];
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/finance_pl_periods**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { id: '66666666-6666-4666-8666-666666666666', name: 'September money check', status: 'draft', period_start: '2026-09-01', period_end: '2026-09-30' },
    ]) });
  });
  await page.route('**/rest/v1/finance_tax_periods**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/rest/v1/service_agreements**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { id: agreementId, name: 'North Yard Agreement', agreement_type: 'operational', invitation_status: 'accepted', provider_organization_id: organizationId, client_organization_id: '40404040-4040-4040-8040-404040404040', client_portal_access_mode: 'transparency_only', client_portal_reports_enabled: true, client_portal_finance_enabled: false, allows_client_submission: false, enabled_modules: ['static_guarding'], created_at: '2026-08-01T00:00:00.000Z', starts_on: '2026-08-01', ends_on: null, provider: { id: organizationId, name: 'Harbour Compliance Services' }, client: { id: '40404040-4040-4040-8040-404040404040', name: 'Civic Events Limited' } },
      { id: otherAgreementId, name: 'South Gate Agreement', agreement_type: 'operational', invitation_status: 'accepted', provider_organization_id: organizationId, client_organization_id: '40404040-4040-4040-8040-404040404040', client_portal_access_mode: 'transparency_only', client_portal_reports_enabled: true, client_portal_finance_enabled: false, allows_client_submission: false, enabled_modules: ['static_guarding'], created_at: '2026-08-02T00:00:00.000Z', starts_on: '2026-08-02', ends_on: null, provider: { id: organizationId, name: 'Harbour Compliance Services' }, client: { id: '40404040-4040-4040-8040-404040404040', name: 'Civic Events Limited' } },
    ]) });
  });
  await page.route('**/rest/v1/shifts**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { id: shiftId, service_type: 'static_guarding', scheduled_start: '2026-09-08T20:00:00.000Z', status: 'accepted', officer_user_id: '22222222-2222-4222-8222-222222222222', service_agreement_location_id: agreementLocationId, service_agreement_module_id: null, work_unit_id: workUnitId },
      { id: unlinkedShiftId, service_type: 'internal', scheduled_start: '2026-09-09T20:00:00.000Z', status: 'accepted', officer_user_id: '22222222-2222-4222-8222-222222222222', service_agreement_location_id: null, service_agreement_module_id: null, work_unit_id: null },
    ]) });
  });
  await page.route('**/rest/v1/service_agreement_locations**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { id: agreementLocationId, service_agreement_id: agreementId, site_id: '42424242-4242-4242-8242-424242424242', zone_id: null, status: 'active' },
    ]) });
  });
  await page.route('**/rest/v1/rpc/record_finance_service_cost', async (route) => {
    costRequests.push(JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: '77777777-7777-4777-8777-777777777777' }) });
  });

  await signInAsAdmin(page, '/admin/finance-money');
  const panel = page.locator('.finance-control-panel');
  await expect(panel).toBeVisible();
  const source = panel.getByLabel('Where this number came from');
  await expect(source).toHaveValue('');
  await expect(panel.getByText('A source reference is required before any cost can be recorded.')).toBeVisible();

  await panel.getByLabel('Which shift').selectOption(shiftId);
  const agreement = panel.getByLabel(/Customer agreement/);
  await expect(agreement).toHaveValue(agreementId);
  await agreement.selectOption(otherAgreementId);
  await expect(agreement).toHaveValue(agreementId);
  const save = panel.getByRole('button', { name: 'Save job cost' });
  await save.click();
  await expect(panel.getByRole('alert')).toContainText('Enter a source reference before recording this cost.');
  expect(costRequests).toHaveLength(0);

  await source.fill('Approved timesheet for North Yard shift 56565656');
  await save.click();
  await expect(panel.locator('.finance-control-message.is-success[role="status"]')).toContainText('Job cost saved with an audit receipt.');
  expect(costRequests).toHaveLength(1);
  expect(costRequests[0]).toMatchObject({
    p_service_agreement_id: agreementId,
    p_shift_id: shiftId,
    p_work_unit_id: workUnitId,
    p_source_reference: 'Approved timesheet for North Yard shift 56565656',
  });
  expect(costRequests[0].p_service_agreement_id).not.toBe(otherAgreementId);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await panel.getByLabel('Which shift').selectOption(unlinkedShiftId);
  await expect(agreement).toHaveValue('');
  await expect(source).toHaveValue('');
  await expect(panel.getByText('This shift has no single contract link. Choose the agreement deliberately and cite the cost source.')).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});