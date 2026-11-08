import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { installSupabaseFixtures, signInAsAdmin, signInAsOfficer } from './fixtures';

test('officer person search requires explicit authorization, then completes a private operational lookup', async ({ page }) => {
  await installSupabaseFixtures(page);
  let authorized = false;
  let searchCalls = 0;
  let expiryCalls = 0;
  await page.route('**/rest/v1/rpc/can_search_people', route => route.fulfill({ json: authorized }));
  await page.route('**/rest/v1/rpc/get_notice_expiry_register', route => {
    expiryCalls++;
    return route.fulfill({ json: [] });
  });
  await page.route('**/rest/v1/rpc/search_people', route => {
    searchCalls++;
    return route.fulfill({ json: [{
      canonical_person_id: 'test-person', display_name: 'Synthetic Permit Holder', review_state: 'verified',
      homeless_status: null, aliases: [], organizations: ['Test organization'],
      has_notice_in_force: true, contact_details_authorised: false, nzta_authorised: false, nzta: null,
      notices: [{ notice_id: 'test-notice', organization_name: 'Test forest', notice_type: 'trespass', notice_number: 'TEST-1',
        status: 'issued', issued_at: '2026-01-01', expires_at: '2028-01-01', expiry_state: 'in_force', location_name: 'Test block' }],
      permits: [], vehicles: [{ canonical_vehicle_id: 'test-vehicle', plate_number: 'ABC123', make: 'Test', model: 'Vehicle', colour: 'Blue', relationship: 'observed_with' }],
    }] });
  });
  await signInAsOfficer(page, '/officer/person_search');
  await expect(page.getByText(/Your administrator must enable Person search/)).toBeVisible();
  await expect(page.getByRole('searchbox')).toHaveCount(0);
  expect(searchCalls).toBe(0);
  authorized = true;
  await page.getByRole('button', { name: 'Check access again' }).click();
  await page.getByRole('searchbox', { name: 'Name, alias or permit number' }).fill('Synthetic');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic Permit Holder' })).toBeVisible();
  await expect(page.getByText('Trespass notice · TEST-1')).toBeVisible();
  await expect(page.getByText('Notice review queue')).toHaveCount(0);
  expect(expiryCalls).toBe(0);
  const layout = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  expect(layout.content).toBeLessThanOrEqual(layout.viewport + 1);
  await page.getByRole('button', { name: 'Open vehicle ABC123 in vehicle search' }).click();
  await expect(page).toHaveURL(/\/officer\/vehicle_lookup\?plate=ABC123$/);
  await expect(page.getByPlaceholder('Enter plate number (e.g. ABC123)')).toHaveValue('ABC123');
});

test('admin vehicle search is available without parking or camping modules', async ({ page, isMobile }) => {
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/organization_modules**', route => route.fulfill({ json: [{ module_key: 'patrol', enabled: true }] }));
  await signInAsAdmin(page, '/admin/field-ops?area=vehicle-search');
  await expect(page.getByRole('heading', { name: 'Vehicle Search & Flags', exact: true })).toBeVisible();
  await page.goto('/admin/field-ops');
  if (isMobile) await page.getByRole('button', { name: /^Operational records/ }).click();
  await page.getByRole('button', { name: /^Vehicle search Search vehicle/ }).click();
  await expect(page).toHaveURL(/area=vehicle-search/);
  await expect(page.getByRole('textbox', { name: 'Registration search' })).toBeVisible();
});

async function personOperationsFixtures(page: Page) {
  await installSupabaseFixtures(page);
  const personId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const clientId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const state = {
    housing: { status: 'none', notes: null as string | null, verified_at: null, version: '2026-01-01T00:00:00Z' },
    flags: [] as Array<{ id: string; alert_level: string; reason: string; active: boolean }>,
    documents: [] as Array<{ id: string; document_type: string; file_name: string; storage_path: string; notice_id: string | null; client_request_id: string; created_at: string }>,
    notices: [] as Array<Record<string, unknown>>,
    housingCalls: [] as Array<Record<string, unknown>>,
    flagCalls: [] as Array<Record<string, unknown>>,
    documentCalls: [] as Array<Record<string, unknown>>,
    operationReads: 0,
    noticeWrites: 0,
    loseDocumentReceipt: true,
    failContext: false,
    emptyHousingReceipt: false,
    emptyResolveReceipt: false,
    verified: true,
    uploadPaths: [] as string[],
  };
  await page.route('**/rest/v1/rpc/**', async route => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    const args = route.request().postDataJSON() as Record<string, unknown>;
    if (name === 'can_search_people') return route.fulfill({ json: true });
    if (['get_notice_expiry_register', 'get_pending_person_detail_updates', 'get_person_interactions', 'get_safety_warnings'].includes(name ?? '')) {
      return route.fulfill({ json: [] });
    }
    if (name === 'search_people') return route.fulfill({ json: [{
      canonical_person_id: personId, display_name: 'Synthetic Welfare Person', review_state: 'verified',
      homeless_status: state.housing.status, has_notice_in_force: state.notices.length > 0,
      aliases: [], organizations: ['Test organisation'], notices: state.notices, permits: [], vehicles: [],
      nzta_authorised: false, nzta: null,
    }] });
    if (name === 'get_person_interest_summary') return route.fulfill({ json: state.flags.map(flag => ({
      alert_level: flag.alert_level, organization_name: 'Test organisation',
    })) });
    if (name === 'get_person_record_operations') {
      state.operationReads += 1;
      if (state.failContext) return route.fulfill({ status: 403, json: { message: 'Synthetic administrator access denied' } });
      return route.fulfill({ json: {
        verified: state.verified, housing: state.housing, flags: state.flags, documents: state.documents, document_total: state.documents.length,
        housing_states: [
          { code: 'none', label: 'No current homelessness recorded', requires_verified_identity: false },
          { code: 'claiming', label: 'Person reports homelessness', requires_verified_identity: false },
          { code: 'confirmed', label: 'Homelessness confirmed by reviewer', requires_verified_identity: true },
        ],
        document_types: [
          { code: 'other', label: 'Supporting document', notice_type: null },
          { code: 'warning', label: 'Existing warning notice', notice_type: 'warning' },
        ],
        clients: [{ id: clientId, name: 'Synthetic landowner client' }],
      } });
    }
    if (name === 'raise_scoped_person_interest_flag') {
      state.flagCalls.push(args);
      state.flags = [{ id: String(args.p_client_request_id), alert_level: String(args.p_alert_level), reason: String(args.p_reason), active: true }];
      return route.fulfill({ json: state.flags[0] });
    }
    if (name === 'resolve_entity_flag') {
      state.flags = [];
      return route.fulfill({ json: state.emptyResolveReceipt ? {} : { id: args.p_flag_id, active: false } });
    }
    if (name === 'update_person_housing_status') {
      state.housingCalls.push(args);
      if (state.emptyHousingReceipt) return route.fulfill({ json: {} });
      state.housing = { status: String(args.p_status), notes: String(args.p_notes), verified_at: null, version: '2026-01-02T00:00:00Z' };
      return route.fulfill({ json: state.housing });
    }
    if (name === 'record_person_document') {
      state.documentCalls.push(args);
      let document = state.documents.find(row => row.client_request_id === args.p_client_request_id);
      if (!document) {
        document = { id: 'synthetic-document', file_name: String(args.p_file_name), storage_path: String(args.p_storage_path),
          document_type: String(args.p_document_type), notice_id: 'synthetic-notice', client_request_id: String(args.p_client_request_id), created_at: '2026-01-15T00:00:00Z' };
        state.documents.push(document);
        state.noticeWrites += 1;
        state.notices.push({ notice_id: 'synthetic-notice', organization_id: clientId, organization_name: 'Synthetic landowner client',
          notice_type: 'warning', notice_number: 'TEST-SOURCE-1', status: 'issued', issued_at: '2026-01-15T00:00:00Z',
          expires_at: '2028-01-15T00:00:00Z', expiry_state: 'in_force', location_name: 'Synthetic north block' });
      }
      if (state.loseDocumentReceipt) {
        state.loseDocumentReceipt = false;
        return route.fulfill({ status: 503, json: { message: 'Synthetic receipt lost after commit' } });
      }
      return route.fulfill({ json: document });
    }
    return route.fallback();
  });
  await page.route('**/storage/v1/object/person-documents/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const duplicate = state.uploadPaths.includes(path);
    state.uploadPaths.push(path);
    return duplicate
      ? route.fulfill({ status: 409, json: { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' } })
      : route.fulfill({ json: { Key: path, Id: 'synthetic-object' } });
  });
  await page.route('**/storage/v1/object/sign/person-documents/**', route => route.fulfill({ json: { signedURL: '/object/sign/person-documents/synthetic-source?token=fixture-only' } }));
  return state;
}

test('person profile completes flags, welfare and an existing notice with lost-receipt recovery on one page', async ({ page }, testInfo) => {
  const state = await personOperationsFixtures(page);
  await signInAsAdmin(page, '/admin/field-ops?area=person-search');
  await page.getByRole('searchbox', { name: 'Name, alias or permit number' }).fill('Synthetic');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const actions = page.getByRole('region', { name: 'Person record actions' });
  await actions.getByLabel('Reason and supporting basis').fill('Reviewed the synthetic source with the affected client.');
  await actions.getByLabel('Flag priority').selectOption('high');
  await actions.getByRole('button', { name: 'Flag as person of interest' }).click();
  await expect(actions.getByText('Active · high')).toBeVisible();
  await actions.getByLabel('Housing status').selectOption('claiming');
  await actions.getByLabel('Welfare notes').fill('Synthetic self-report; welfare review requested.');
  await actions.getByRole('button', { name: 'Save homelessness record' }).click();
  await expect(actions.getByText(/Person homelessness record updated/)).toBeVisible();
  expect(state.housingCalls[0].p_expected_version).toBe('2026-01-01T00:00:00Z');
  await expect(page.getByRole('note')).toContainText('homelessness status is claiming');

  await actions.getByLabel('Document type').selectOption('warning');
  const source = Buffer.from('%PDF-1.4\nSynthetic already-issued warning. No real person data.\n%%EOF');
  await actions.getByLabel('Original document').setInputFiles({ name: 'synthetic-warning.pdf', mimeType: 'application/pdf', buffer: source });
  await actions.getByLabel('Client organisation').selectOption('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  await actions.getByLabel('Issued on (New Zealand date)').fill('2026-01-15');
  await actions.getByLabel('Affected place or area on source').fill('Synthetic north block');
  await actions.getByLabel('Notice number (optional)').fill('TEST-SOURCE-1');
  const save = actions.getByRole('button', { name: 'Save source and record existing notice' });
  await expect(save).toBeDisabled();
  await actions.getByRole('checkbox', { name: /I compared this source/ }).check();
  await save.click();
  await expect(actions.getByRole('alert')).toContainText('Synthetic receipt lost after commit');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(actions.getByRole('status').filter({ hasText: 'No new notice was served.' })).toBeVisible();
  expect(state.uploadPaths).toHaveLength(2);
  expect(state.uploadPaths[0]).toBe(state.uploadPaths[1]);
  expect(state.documentCalls[0].p_client_request_id).toBe(state.documentCalls[1].p_client_request_id);
  expect(state.documentCalls[0].p_sha256).toBe(createHash('sha256').update(source).digest('hex'));
  expect(state.noticeWrites).toBe(1);
  await expect(page.getByText('Warning notice · TEST-SOURCE-1')).toBeVisible();
  await actions.getByLabel('Welfare notes').fill('Unsaved draft must survive opening the source.');
  await actions.getByRole('button', { name: 'Get private source link' }).click();
  await expect(actions.getByRole('link', { name: /Open original document/ })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(actions.getByLabel('Welfare notes')).toHaveValue('Unsaved draft must survive opening the source.');
  await actions.getByRole('button', { name: 'Resolve person-of-interest flag' }).click();
  await expect(actions.getByText(/flag resolved with your reason retained/)).toBeVisible();
  await expect(actions.getByLabel('Welfare notes')).toHaveValue('Unsaved draft must survive opening the source.');
  await expect(actions.getByRole('button', { name: 'Flag as person of interest' })).toBeEnabled();
  await actions.getByRole('button', { name: 'Flag as person of interest' }).click();
  await expect(actions.getByText('Active · high')).toBeVisible();
  expect(state.flagCalls).toHaveLength(2);
  expect(state.flagCalls[0].p_client_request_id).not.toBe(state.flagCalls[1].p_client_request_id);
  await expect(actions.getByRole('button', { name: 'Resolve person-of-interest flag' })).toBeEnabled();
  const layout = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  expect(layout.content).toBeLessThanOrEqual(layout.viewport + 1);
  for (const [heading, file] of [
    ['Person of interest', 'person-flags.png'],
    ['Homelessness and welfare', 'person-welfare.png'],
    ['Documents and existing notices', 'person-document-fields.png'],
    ['Saved documents (1)', 'person-document-receipt.png'],
  ]) {
    await actions.getByRole('heading', { name: heading, exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(file) });
  }
});

test('person actions fail visibly and do not claim a housing update without a receipt', async ({ page }) => {
  const state = await personOperationsFixtures(page);
  state.failContext = true;
  await signInAsAdmin(page, '/admin/field-ops?area=person-search');
  await page.getByRole('searchbox', { name: 'Name, alias or permit number' }).fill('Synthetic');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const actions = page.getByRole('region', { name: 'Person record actions' });
  await expect(actions.getByRole('alert')).toContainText('administrator access denied');
  await expect(actions.getByLabel('Housing status')).toHaveCount(0);
  state.failContext = false;
  state.verified = false;
  await actions.getByRole('button', { name: 'Reload person actions' }).click();
  await expect(actions.getByText('Verify the person record and canonical identity before raising a person-of-interest flag.')).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Flag as person of interest' })).toHaveCount(0);
  await expect(actions.getByRole('option', { name: 'Homelessness confirmed by reviewer' })).toHaveJSProperty('disabled', true);
  await actions.getByLabel('Reason and supporting basis').fill('Synthetic review reason.');
  await actions.getByLabel('Housing status').selectOption('claiming');
  state.emptyHousingReceipt = true;
  await actions.getByRole('button', { name: 'Save homelessness record' }).click();
  await expect(actions.getByRole('alert')).toContainText('No housing update receipt returned');
  await expect(actions.getByText(/Person homelessness record updated/)).toHaveCount(0);
  await expect(actions.getByRole('button', { name: 'Save homelessness record' })).toBeEnabled();
  state.verified = true;
  await actions.getByRole('button', { name: 'Reload person actions' }).click();
  await actions.getByRole('button', { name: 'Flag as person of interest' }).click();
  await expect(actions.getByText('Active · medium')).toBeVisible();
  state.emptyResolveReceipt = true;
  await actions.getByRole('button', { name: 'Resolve person-of-interest flag' }).click();
  await expect(actions.getByRole('alert')).toContainText('No resolved flag receipt returned');
  await expect(actions.getByText(/flag resolved with your reason retained/)).toHaveCount(0);
});

test('authorized officers see person concerns and housing context without administrator write controls', async ({ page }) => {
  const state = await personOperationsFixtures(page);
  state.flags = [{ id: 'synthetic-flag', alert_level: 'high', reason: 'PRIVATE ADMINISTRATOR BASIS', active: true }];
  state.housing.status = 'claiming';
  await signInAsOfficer(page, '/officer/person_search');
  await page.getByRole('searchbox', { name: 'Name, alias or permit number' }).fill('Synthetic');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Person-of-interest flags' })).toContainText('high');
  await expect(page.getByRole('note').filter({ hasText: 'Welfare:' })).toContainText('homelessness status is claiming');
  await expect(page.getByText('PRIVATE ADMINISTRATOR BASIS')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Person record actions' })).toHaveCount(0);
  expect(state.operationReads).toBe(0);
});
