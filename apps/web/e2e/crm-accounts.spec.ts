import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00')); await installSupabaseFixtures(page); });

test('client profile switches between details and locations without losing a draft', async ({ page }) => {
  await signInAsAdmin(page, '/admin/crm');
  await page.locator('#crm-account-40404040-4040-4040-8040-404040404040').click();
  const profile = page.getByRole('region', { name: 'Selected client' });
  await profile.getByLabel('Client name', { exact: true }).fill('Civic Events draft');
  await profile.getByRole('button', { name: 'Locations', exact: true }).click();
  await expect(profile.getByRole('region', { name: 'Client locations' })).toBeVisible();
  await expect(profile.getByRole('form', { name: 'Client details' })).toBeHidden();
  await profile.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(profile.getByLabel('Client name', { exact: true })).toHaveValue('Civic Events draft');
  await profile.getByRole('button', { name: 'Activity', exact: true }).click();
  const accountWorkspace = page.getByRole('dialog', { name: 'Civic Events Limited' });
  await expect(accountWorkspace.locator('.crm-workspace-toolbar').nth(1)).toContainText('Relationship timeline');
  await accountWorkspace.getByRole('button', { name: /Finance/ }).click();
  await expect(accountWorkspace.locator('.crm-workspace-toolbar').nth(1)).toContainText('Finance');
  await accountWorkspace.getByRole('button', { name: 'Close client portfolio' }).click();
  await expect(profile.getByLabel('Client name', { exact: true })).toHaveValue('Civic Events draft');
});

test('operating branch selector is visible and switches the session context', async ({ page }) => {
  const errors = monitorBrowserErrors(page); await signInAsAdmin(page, '/admin/crm');
  const selector = page.getByLabel('Working in');
  await expect(selector).toHaveValue('41414141-4141-4141-8141-414141414141');
  await expect(selector.locator('option').nth(0)).toContainText('Northern Branch');
  await expect(selector.locator('option').nth(1)).toContainText('Southern Branch');
  await expect(page.locator('.admin-shell-header, .admin-mobile-header')).toHaveScreenshot('operating-branch-selector.png');
  await selector.selectOption('45454545-4545-4545-8545-454545454545');
  await expect(selector).toHaveValue('45454545-4545-4545-8545-454545454545');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('CRM account context and governed quote creation are operational', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await page.route('**/rest/v1/workshop_bom_templates*', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 'tpl-lockbox', name: 'Standard lockbox', kind: 'fabrication', description: 'Box section, fixings and fabrication labour.' }]) }));
  await page.route('**/rest/v1/workshop_bom_template_lines*', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 'tpl-line-1', line_kind: 'material', item_id: 'item-steel', description: '200x200mm box section', quantity: 2.5, unit_of_measure: 'm', position: 1 }, { id: 'tpl-line-2', line_kind: 'labour', item_id: null, description: 'Cut, weld, finish', quantity: 3, unit_of_measure: 'hr', position: 2 }]) }));
  await page.route('**/rest/v1/finance_price_book*', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ item_id: 'item-steel', unit_cost: 40, unit_price: 62 }]) }));
  await page.route('**/rest/v1/rpc/add_crm_quote_lines_from_bom_template', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ lines_added: 2, lines_needing_price: 1, total_cost: 380, subtotal_charge: 549, total_charge: 631.35 }]) }));
  await signInAsAdmin(page, '/admin/crm');
  await expect(page.getByRole('heading', { name: 'Client Portfolios', exact: true })).toBeVisible();
  const client = page.locator('#crm-account-40404040-4040-4040-8040-404040404040');
  await client.click();
  const workspace = page.getByRole('dialog', { name: 'Civic Events Limited' });
  await workspace.getByRole('button', { name: 'Places 1' }).click();
  await expect(workspace.getByText('Civic Centre', { exact: true })).toBeVisible();
  await workspace.getByRole('button', { name: 'Create proposal' }).click();
  const dialog = page.getByRole('dialog', { name: /New quote for Civic Events Limited/ });
  await expect(dialog.getByLabel('Quote title')).toHaveValue(/Civic Events Limited - .* proposal/);
  await dialog.getByLabel('Target margin %').fill('24'); await dialog.getByLabel('Commercial notes').fill('Initial static guarding proposal.');
  await dialog.getByLabel('Include static_guarding').check();
    const proposalHeaders = dialog.locator('.crm-proposal-module-row.is-header > span');
  if ((page.viewportSize()?.width ?? 0) <= 760) {
      await expect(proposalHeaders.first()).toBeHidden();
  } else {
    const includeHeader = await proposalHeaders.nth(0).boundingBox();
    const moduleHeader = await proposalHeaders.nth(1).boundingBox();
    expect(includeHeader).not.toBeNull();
    expect(moduleHeader).not.toBeNull();
    expect(includeHeader!.x + includeHeader!.width).toBeLessThanOrEqual(moduleHeader!.x);
  }
  await expect(dialog).toHaveScreenshot('crm-draft-quote.png'); await dialog.getByRole('button', { name: 'Create draft quote' }).click();
  await expect(page.getByText('Draft quote created for Civic Events Limited. Add explicit pricing lines before review.')).toBeVisible();
  const pricing = page.getByRole('dialog', { name: /Price Civic Events Limited - .* proposal/ });
  await pricing.getByLabel('Quantity').fill('8'); await pricing.getByLabel('Provider unit cost').fill('35'); await pricing.getByLabel('Client unit charge').fill('52.5');
  await expect(pricing).toHaveScreenshot('crm-quote-pricing.png'); await pricing.getByRole('button', { name: 'Add pricing line' }).click();
  await expect(pricing.getByText('Total cost $280.00')).toBeVisible(); await expect(pricing.getByText('Total charge $483.00')).toBeVisible();
  await pricing.getByLabel('Add a standard build').selectOption('tpl-lockbox');
  await expect(pricing.getByText('Review before adding')).toBeVisible();
  await expect(pricing.getByText('2.5 m · 200x200mm box section')).toBeVisible();
  await expect(pricing.getByText('$155.00')).toBeVisible();
  await expect(pricing.getByText('1 line needs a price before the quote can be sent.')).toBeVisible();
  await pricing.getByRole('button', { name: 'Add its lines' }).click();
  await expect(page.getByText(/2 lines from Standard lockbox added.*1 line has no price yet/)).toBeVisible();
  await pricing.getByRole('button', { name: 'Send quote' }).click();const sendDialog=page.getByRole('dialog',{name:'Send quote?'});await expect(sendDialog).toHaveScreenshot('crm-send-quote.png');await sendDialog.getByRole('button',{name:'Confirm send'}).click();await expect(page.getByText(/Civic Events Limited - .* proposal sent for acceptance\./)).toBeVisible();
  await pricing.getByRole('button', { name: 'Accept quote' }).click();const acceptDialog=page.getByRole('dialog',{name:'Accept quote?'});await expect(acceptDialog).toHaveScreenshot('crm-accept-quote.png');await acceptDialog.getByRole('button',{name:'Confirm acceptance'}).click();
  const receipt = page.getByRole('region', { name: 'Quote acceptance receipt' });await expect(receipt).toContainText('Service agreement 46464646 established for Civic Events Limited.');await receipt.getByRole('button',{name:'Open service agreement'}).click();
  await expect(page).toHaveURL(/\/admin\/relationships\?account=40404040-4040-4040-8040-404040404040&agreement=46464646-4646-4646-8646-464646464646$/);await expect(page.getByRole('heading', { name: 'Civic Events Compliance Services', exact: true })).toBeVisible(); expect(errors, errors.join('\n')).toEqual([]);
});

test('a draft quote line can be corrected without removing its identity', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/crm');
  await page.locator('#crm-account-40404040-4040-4040-8040-404040404040').click();
  const workspace = page.getByRole('dialog', { name: 'Civic Events Limited' });
  await workspace.getByRole('button', { name: 'Places 1' }).click();
  await workspace.getByRole('button', { name: 'Create proposal' }).click();
  const createDialog = page.getByRole('dialog', { name: /New quote for Civic Events Limited/ });
  await createDialog.getByLabel('Include static_guarding').check();
  await createDialog.getByRole('button', { name: 'Create draft quote' }).click();

  const pricing = page.getByRole('dialog', { name: /Price Civic Events Limited - .* proposal/ });
  await expect(pricing.getByText('This records the source and does not change quote line charges or totals.')).toBeVisible();
  await pricing.getByLabel('Tender source').selectOption('47474747-4747-4747-8747-474747474747');
  await pricing.getByLabel('Approved discount plan').selectOption('49494949-4949-4949-8949-494949494949');
  await pricing.getByRole('button', { name: 'Save commercial basis' }).click();
  await expect(page.getByText(/Commercial basis saved.*Quote line charges were not changed/)).toBeVisible();
  await expect(pricing.getByRole('button', { name: 'Save commercial basis' })).toBeDisabled();
  await pricing.getByLabel('Quantity').fill('8');
  await pricing.getByLabel('Provider unit cost').fill('35');
  await pricing.getByLabel('Client unit charge').fill('52.5');
  await pricing.getByRole('button', { name: 'Add pricing line' }).click();
  await expect(pricing.getByText('Service labour')).toBeVisible();

  await pricing.getByRole('button', { name: 'Edit' }).click();
  await pricing.getByLabel('Edit line description').fill('Discarded correction');
  await pricing.getByRole('button', { name: 'Cancel' }).click();
  await expect(pricing.getByText('Service labour')).toBeVisible();
  await expect(pricing.getByText('Discarded correction')).toHaveCount(0);

  await pricing.getByRole('button', { name: 'Edit' }).click();
  await pricing.getByLabel('Edit line description').fill('Service labour - revised');
  await pricing.getByLabel('Edit provider unit cost').fill('38');
  await pricing.getByLabel('Edit client unit charge').fill('57');
  await pricing.getByRole('button', { name: 'Save line' }).click();

  await expect(page.getByText(/Pricing line updated on Civic Events Limited/)).toBeVisible();
  await expect(pricing.getByText('Service labour - revised')).toBeVisible();
  await expect(pricing.getByText('Total cost $304.00')).toBeVisible();
  await expect(pricing.getByText('Total charge $524.40')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('a quote can be raised as a variation of the client\'s existing agreement', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  const agreementQueries: string[] = [];
  let quotePayload: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/service_agreements**', async (route) => {
    const url = new URL(route.request().url());
    const select = url.searchParams.get('select') ?? '';
    if (!select.startsWith('id,name,starts_on,ends_on,invitation_status')) { await route.fallback(); return; }
    agreementQueries.push(url.search);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([
      { id: '24242424-2424-4424-8424-242424242424', name: 'Civic Events Compliance Services', starts_on: '2026-08-01', ends_on: null, invitation_status: 'accepted', agreement_type: 'operational' },
      { id: '25252525-2525-4525-8525-252525252525', name: 'Expired summer patrols', starts_on: '2025-11-01', ends_on: '2026-03-31', invitation_status: 'accepted', agreement_type: 'operational' },
    ]) });
  });
  await page.route('**/rest/v1/rpc/create_crm_draft_quote_for_provider', async (route) => {
    quotePayload = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: '44444444-4444-4444-8444-444444444449', client_org_id: '40404040-4040-4040-8040-404040404040', provider_org_id: '41414141-4141-4141-8141-414141414141', status: 'draft', title: 'Civic Events Limited - Civic Centre proposal', service_agreement_id: '24242424-2424-4424-8424-242424242424' }) });
  });
  await signInAsAdmin(page, '/admin/crm');
  await page.locator('#crm-account-40404040-4040-4040-8040-404040404040').click();
  const workspace = page.getByRole('dialog', { name: 'Civic Events Limited' });
  await workspace.getByRole('button', { name: 'Places 1' }).click();
  await workspace.getByRole('button', { name: 'Create proposal' }).click();
  const dialog = page.getByRole('dialog', { name: /New quote for Civic Events Limited/ });
  const purpose = dialog.getByRole('group', { name: 'What is this quote for?' });
  await expect(purpose.getByRole('radio', { name: /A new agreement/ })).toBeChecked();
  await purpose.getByRole('radio', { name: /A change to an existing agreement \(variation\)/ }).check();
  const agreementSelect = purpose.getByLabel('Agreement being varied');
  await expect(agreementSelect).toHaveValue('24242424-2424-4424-8424-242424242424');
  await expect(agreementSelect.locator('option')).toHaveCount(1);
  expect(agreementQueries.length).toBeGreaterThan(0);
  expect(agreementQueries[0]).toContain('client_organization_id=eq.40404040-4040-4040-8040-404040404040');
  expect(agreementQueries[0]).toContain('agreement_type=eq.operational');
  await dialog.getByLabel('Include static_guarding').check();
  await dialog.getByRole('button', { name: 'Create draft quote' }).click();
  await expect(page.getByText('Draft variation created for Civic Events Compliance Services. Add the new places, services, and prices, then send it for acceptance.')).toBeVisible();
  expect(quotePayload).toMatchObject({ p_client_org_id: '40404040-4040-4040-8040-404040404040', p_service_agreement_id: '24242424-2424-4424-8424-242424242424' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('a saved workshop build adds its priced lines to a draft quote at the selected client site', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  let templateRequest: Record<string, unknown> | null = null;
  let copiedLines: Array<Record<string, unknown>> = [];
  await page.route('**/rest/v1/workshop_bom_templates*', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([
    { id: 'babebabe-babe-4abe-8abe-babebabebabe', name: 'Standard lockbox', kind: 'fabrication', description: 'Lockbox steel, fixings and workshop labour.' },
  ]) }));
  await page.route('**/rest/v1/quote_lines*', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify(copiedLines) }));
  await page.route('**/rest/v1/rpc/add_crm_quote_lines_from_bom_template', async (route) => {
    templateRequest = JSON.parse(route.request().postData() ?? '{}');
    copiedLines = [
      { id: 'line-1', kind: 'materials', description: 'Standard lockbox — 200x200mm box section', quantity: 2.5, unit_cost: 40, unit_charge: 62 },
      { id: 'line-2', kind: 'labour', description: 'Standard lockbox — Cut, weld, finish', quantity: 3, unit_cost: 45, unit_charge: 95 },
    ];
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ lines_added: 2, lines_needing_price: 0, quote_id: '44444444-4444-4444-8444-444444444449', total_cost: 235, subtotal_charge: 440, discount_amount: 0, gst_amount: 66, total_charge: 506 }]) });
  });

  await signInAsAdmin(page, '/admin/crm');
  await page.locator('#crm-account-40404040-4040-4040-8040-404040404040').click();
  const workspace = page.getByRole('dialog', { name: 'Civic Events Limited' });
  await workspace.getByRole('button', { name: 'Places 1' }).click();
  await workspace.getByRole('button', { name: 'Create proposal' }).click();
  const createDialog = page.getByRole('dialog', { name: /New quote for Civic Events Limited/ });
  await createDialog.getByLabel('Include static_guarding').check();
  await createDialog.getByRole('button', { name: 'Create draft quote' }).click();

  const pricing = page.getByRole('dialog', { name: /Price Civic Events Limited - .* proposal/ });
  await pricing.getByLabel('Add a standard build').selectOption('babebabe-babe-4abe-8abe-babebabebabe');
  await pricing.getByRole('button', { name: 'Add its lines' }).click();

  await expect(page.getByText('2 lines from Standard lockbox added to Civic Events Limited - Civic Centre proposal.')).toBeVisible();
  await expect(pricing.getByText('Standard lockbox — 200x200mm box section')).toBeVisible();
  await expect(pricing.getByText('Standard lockbox — Cut, weld, finish')).toBeVisible();
  await expect(pricing.getByText('Total cost $235.00')).toBeVisible();
  await expect(pricing.getByText('Total charge $506.00')).toBeVisible();
  expect(templateRequest).toMatchObject({
    p_quote_id: '44444444-4444-4444-8444-444444444449',
    p_expected_status: 'draft',
    p_template_id: 'babebabe-babe-4abe-8abe-babebabebabe',
    p_site_id: '25252525-2525-4525-8525-252525252525',
  });
  expect(templateRequest).toMatchObject({ p_client_request_id: expect.any(String) });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('account team manages contacts, follow-up activity, and receivables', async ({ page }) => {
  const errors = monitorBrowserErrors(page); await signInAsAdmin(page, '/admin/crm');
  const client = page.locator('#crm-account-40404040-4040-4040-8040-404040404040');
  await client.click();
  const workspace = page.getByRole('dialog', { name: 'Civic Events Limited' });
  await workspace.getByRole('button', { name: /Contacts/ }).click();
  await expect(workspace.getByText('Mere Wilson')).toBeVisible();
  await workspace.getByRole('button', { name: 'Add contact' }).click();
  await workspace.getByLabel('First name').fill('Aria'); await workspace.getByLabel('Last name').fill('Rangi');
  await workspace.getByLabel('Role or title').fill('Operations Lead'); await workspace.getByLabel('Email').fill('aria@civic.test');
  await workspace.getByText('Primary contact', { exact: true }).click();
  await workspace.getByRole('button', { name: 'Add contact', exact: true }).last().click();
  await expect(workspace.getByText('Aria Rangi')).toBeVisible();

  await workspace.getByRole('button', { name: /Activity/ }).click(); await workspace.getByRole('button', { name: 'Log activity' }).click();
  await workspace.getByLabel('Activity type').selectOption('meeting'); await workspace.getByLabel('Subject').fill('Mobilisation review');
  await workspace.getByLabel('Details').fill('Confirmed access contacts and opening-day responsibilities.');
  await workspace.getByLabel('Outcome').fill('Mobilisation remains on schedule.');
  await workspace.getByLabel('Follow up at').fill('2026-09-02T10:00');
  await workspace.getByRole('button', { name: 'Record activity' }).click();
  await expect(workspace.getByText('Mobilisation review')).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) <= 760) {
    const activityCard = workspace.locator('.crm-activity-list article').filter({ hasText: 'Mobilisation review' });
    const activityColumns = await activityCard.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
    expect(activityColumns).toBe(1);
    expect(await activityCard.locator('.crm-follow-up').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  await expect(workspace).toHaveScreenshot('crm-account-workspace.png');
  await workspace.getByRole('button', { name: 'Close client portfolio' }).click();

  const invoice = page.getByText('INV-2026-0042').locator('..');
  await expect(invoice.getByText('NZD 2484.50')).toBeVisible(); await invoice.getByRole('button', { name: 'Mark paid' }).click();
  const payment = page.getByRole('dialog', { name: 'Confirm payment' }); await payment.getByRole('button', { name: 'Confirm action' }).click();
  await expect(page.getByText('INV-2026-0042 marked paid.')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('relationships workspace opens the operational account record', async ({ page }) => {
  const errors = monitorBrowserErrors(page); await signInAsAdmin(page, '/admin/relationships');
  await expect(page.getByRole('heading', { name: 'Relationship Workspace' })).toBeVisible();
  const relationship = page.getByText('Civic Events Compliance Services', { exact: true }).locator('..').locator('..').locator('..');
  await expect(relationship.getByText('Civic Events Limited', { exact: true }).first()).toBeVisible();
  await relationship.getByRole('button', { name: 'Manage relationship' }).click();
  const workspace = page.getByRole('dialog', { name: 'Civic Events Limited' });
  await workspace.getByRole('button', { name: /Contacts/ }).click();
  await expect(workspace.getByText('Mere Wilson')).toBeVisible();
  await workspace.getByRole('button', { name: /Activity/ }).click();
  await workspace.getByRole('button', { name: 'Log activity' }).click();
  await workspace.getByLabel('Activity type').selectOption('note');
  await workspace.getByLabel('Subject').fill('Agreement handover note');
  await workspace.getByLabel('Details').fill('Account team confirmed the operational handover contacts.');
  await workspace.getByRole('button', { name: 'Record activity' }).click();
  await expect(workspace.getByText('Agreement handover note')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('location house lookup exposes shared setup and allows a separate account house', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await page.route('**/rest/v1/rpc/find_crm_location_candidates', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{
    location_id: '91919191-9191-4919-8919-919191919191', name: 'Nelson Civic Centre', address: '1 Civic Square, Nelson', suburb: 'Nelson', postcode: '7010',
    site_count: 2, zone_count: 1, boundary_state: 'verified geometry available', match_reason: 'Exact address match', belongs_to_account: false,
  }]) }));
  await signInAsAdmin(page, '/admin/crm');
  await page.locator('#crm-account-40404040-4040-4040-8040-404040404040').click();
  await page.getByRole('button', { name: 'Full account workspace' }).click();
  const workspace = page.getByRole('dialog', { name: 'Civic Events Limited' });
  await workspace.getByRole('button', { name: 'Places 1' }).click();
  await workspace.getByRole('button', { name: 'Find or add location' }).click();
  await workspace.getByLabel('Location name').fill('Nelson Civic Centre');
  await workspace.getByLabel('Street address').fill('1 Civic Square, Nelson');
  await workspace.getByRole('button', { name: 'Search places' }).click();
  const lookup = workspace.getByText('Possible physical place matches').locator('..');
  await expect(lookup).toContainText('Nelson Civic Centre');
  await expect(lookup).toContainText('2 site facets · 1 zone facet · verified geometry available');
  await expect(lookup).toContainText('Another account already has its own house at this address.');
  await expect(lookup.getByRole('button', { name: 'Create location for this account' })).toBeVisible();
  await expect(lookup).not.toContainText('finance');
  await expect(lookup).not.toContainText('Safety');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('location house lookup ignores results returned for an edited address', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  let releaseFirstLookup!: () => void;
  let startFirstLookup!: () => void;
  const firstLookupGate = new Promise<void>((resolve) => { releaseFirstLookup = resolve; });
  const firstLookupStarted = new Promise<void>((resolve) => { startFirstLookup = resolve; });
  let lookupCount = 0;
  let firstLookupCompleted = false;
  await page.route('**/rest/v1/rpc/find_crm_location_candidates', async (route) => {
    lookupCount += 1;
    if (lookupCount === 1) {
      startFirstLookup();
      await firstLookupGate;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{
        location_id: '91919191-9191-4919-8919-919191919191', name: 'Old address match', address: '1 Old Street, Nelson', suburb: 'Nelson', postcode: '7010',
        site_count: 1, zone_count: 0, boundary_state: 'no geometry recorded', match_reason: 'Exact address match', belongs_to_account: true,
      }]) });
      firstLookupCompleted = true;
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: '[]' });
  });
  await signInAsAdmin(page, '/admin/crm');
  await page.locator('#crm-account-40404040-4040-4040-8040-404040404040').click();
  await page.getByRole('button', { name: 'Full account workspace' }).click();
  const workspace = page.getByRole('dialog', { name: 'Civic Events Limited' });
  await workspace.getByRole('button', { name: 'Places 1' }).click();
  await workspace.getByRole('button', { name: 'Find or add location' }).click();
  await workspace.getByLabel('Location name').fill('Old address');
  await workspace.getByLabel('Street address').fill('1 Old Street, Nelson');
  await workspace.getByRole('button', { name: 'Search places' }).click();
  await firstLookupStarted;
  await workspace.getByLabel('Street address').fill('2 New Street, Nelson');
  releaseFirstLookup();
  await expect.poll(() => firstLookupCompleted).toBe(true);
  await expect(workspace.getByText('Possible physical place matches')).toHaveCount(0);
  await workspace.getByRole('button', { name: 'Search places' }).click();
  await expect(workspace.getByText('No matching physical places found')).toBeVisible();
  await expect(workspace.getByRole('button', { name: 'Create location for this account' })).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('location house lookup ignores errors returned for an edited address', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  let releaseFirstLookup!: () => void;
  let startFirstLookup!: () => void;
  const firstLookupGate = new Promise<void>((resolve) => { releaseFirstLookup = resolve; });
  const firstLookupStarted = new Promise<void>((resolve) => { startFirstLookup = resolve; });
  let lookupCount = 0;
  let firstLookupCompleted = false;
  await page.route('**/rest/v1/rpc/find_crm_location_candidates', async (route) => {
    lookupCount += 1;
    if (lookupCount === 1) {
      startFirstLookup();
      await firstLookupGate;
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'P0001', message: 'Old address lookup failed', details: null, hint: null }),
      });
      firstLookupCompleted = true;
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: '[]' });
  });
  await signInAsAdmin(page, '/admin/crm');
  await page.locator('#crm-account-40404040-4040-4040-8040-404040404040').click();
  await page.getByRole('button', { name: 'Full account workspace' }).click();
  const workspace = page.getByRole('dialog', { name: 'Civic Events Limited' });
  await workspace.getByRole('button', { name: 'Places 1' }).click();
  await workspace.getByRole('button', { name: 'Find or add location' }).click();
  await workspace.getByLabel('Location name').fill('Old address');
  await workspace.getByLabel('Street address').fill('1 Old Street, Nelson');
  await workspace.getByRole('button', { name: 'Search places' }).click();
  await firstLookupStarted;
  await workspace.getByLabel('Street address').fill('2 New Street, Nelson');
  releaseFirstLookup();
  await expect.poll(() => firstLookupCompleted).toBe(true);
  await expect(workspace.getByRole('alert')).toHaveCount(0);
  await workspace.getByRole('button', { name: 'Search places' }).click();
  await expect(workspace.getByText('No matching physical places found')).toBeVisible();
  await expect(workspace.getByRole('alert')).toHaveCount(0);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain('status of 400 (Bad Request)');
});

test('administrator creates and edits organizations through the human account spine', async ({ page }) => {
  const errors = monitorBrowserErrors(page); await signInAsAdmin(page, '/admin/crm');
  await page.getByRole('button', { name: 'Add other organisation' }).click();
  let dialog = page.getByRole('dialog', { name: 'Find or add an organization' });
  await dialog.getByLabel('Organization name').fill('Civic Events');
  await dialog.getByRole('button', { name: 'Search organizations' }).click();
  await expect(dialog.getByText('Possible matches')).toBeVisible();
  await expect(dialog.getByText('Civic Events Limited', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Managed account/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Close organization dialog' }).click();

  await page.getByRole('button', { name: 'Add other organisation' }).click();
  dialog = page.getByRole('dialog', { name: 'Find or add an organization' });
  await dialog.getByLabel('Organization name').fill('Harbour Arts Trust');
  await dialog.getByRole('button', { name: 'Search organizations' }).click();
  await expect(dialog.getByText('No matching organizations found')).toBeVisible();
  await dialog.getByRole('button', { name: 'Create new prospect' }).click();
  const create = page.getByRole('dialog', { name: 'Create prospect' });
  await create.getByLabel('General email').fill('operations@harbourarts.test');
  await create.getByLabel('Billing email').fill('accounts@harbourarts.test');
  await create.getByLabel('Billing address').fill('8 Haven Road, Nelson');
  await create.getByLabel('Account context').fill('Prospective venue compliance and patrol account.');
  await create.getByRole('button', { name: 'Create inactive prospect' }).click();
  const created = page.getByRole('dialog', { name: 'Prospect created' });
  await expect(created.getByText('Harbour Arts Trust is now a prospect')).toBeVisible();
  await created.getByRole('button', { name: 'Continue to places' }).click();
  const workspace = page.getByRole('dialog', { name: 'Harbour Arts Trust' });
  await workspace.getByRole('button', { name: 'Places 1' }).click();
  await expect(workspace.getByRole('button', { name: 'Find or add location' })).toBeVisible();
  await workspace.getByRole('button', { name: /Contacts/ }).click();
  await workspace.getByRole('button', { name: 'Add contact' }).click();
  await workspace.getByLabel('First name').fill('Hana'); await workspace.getByLabel('Last name').fill('Te Aho');
  await workspace.getByLabel('Role or title').fill('Venue Manager'); await workspace.getByLabel('Email').fill('hana@harbourarts.test');
  await workspace.getByText('Primary contact', { exact: true }).click();
  await workspace.getByRole('button', { name: 'Add contact', exact: true }).last().click();
  await expect(workspace.getByText('Hana Te Aho')).toBeVisible();
  await workspace.getByRole('button', { name: /Overview/ }).click();
  await expect(workspace.getByRole('button', { name: 'Edit organization details' })).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});