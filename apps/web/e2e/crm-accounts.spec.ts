import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00')); await installSupabaseFixtures(page); });

test('operating branch selector is visible and switches the session context', async ({ page }) => {
  const errors = monitorBrowserErrors(page); await signInAsAdmin(page, '/admin/crm');
  const selector = page.getByLabel('Operating branch');
  await expect(selector).toHaveValue('41414141-4141-4141-8141-414141414141');
  await expect(selector.locator('option').nth(0)).toContainText('Northern Branch');
  await expect(selector.locator('option').nth(1)).toContainText('Southern Branch');
  await expect(page.locator('.admin-shell-header, .admin-mobile-header')).toHaveScreenshot('operating-branch-selector.png');
  await selector.selectOption('45454545-4545-4545-8545-454545454545');
  await expect(selector).toHaveValue('45454545-4545-4545-8545-454545454545');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('CRM account context and governed quote creation are operational', async ({ page }) => {
  const errors = monitorBrowserErrors(page); await signInAsAdmin(page, '/admin/crm');
  await expect(page.getByRole('heading', { name: 'CRM & Finance', exact: true })).toBeVisible();
  const client = page.locator('#crm-account-40404040-4040-4040-8040-404040404040');
  await client.click();
  const workspace = page.getByRole('dialog', { name: 'Civic Events Limited' });
  await workspace.getByRole('button', { name: 'Create proposal' }).click();
  const dialog = page.getByRole('dialog', { name: 'New quote for Civic Events Limited' });
  await expect(dialog.getByLabel('Quote title')).toHaveValue('Civic Events Limited service proposal');
  await dialog.getByLabel('Target margin %').fill('24'); await dialog.getByLabel('Commercial notes').fill('Initial static guarding proposal.');
  await dialog.getByLabel('Include static_guarding').check();
  await expect(dialog).toHaveScreenshot('crm-draft-quote.png'); await dialog.getByRole('button', { name: 'Create draft quote' }).click();
  await expect(page.getByText('Draft quote created for Civic Events Limited. Add explicit pricing lines before review.')).toBeVisible();
  const pricing = page.getByRole('dialog', { name: 'Price Civic Events Limited service proposal' });
  await expect(pricing.getByLabel('Client site')).toHaveValue('42424242-4242-4242-8242-424242424242');
  await pricing.getByLabel('Quantity').fill('8'); await pricing.getByLabel('Provider unit cost').fill('35'); await pricing.getByLabel('Client unit charge').fill('52.5');
  await expect(pricing).toHaveScreenshot('crm-quote-pricing.png'); await pricing.getByRole('button', { name: 'Add pricing line' }).click();
  await expect(pricing.getByText('Total cost $280.00')).toBeVisible(); await expect(pricing.getByText('Total charge $483.00')).toBeVisible();
  await pricing.getByRole('button', { name: 'Send quote' }).click();const sendDialog=page.getByRole('dialog',{name:'Send quote?'});await expect(sendDialog).toHaveScreenshot('crm-send-quote.png');await sendDialog.getByRole('button',{name:'Confirm send'}).click();await expect(page.getByText('Civic Events Limited service proposal sent for acceptance.')).toBeVisible();
  await pricing.getByRole('button', { name: 'Accept quote' }).click();const acceptDialog=page.getByRole('dialog',{name:'Accept quote?'});await expect(acceptDialog).toHaveScreenshot('crm-accept-quote.png');await acceptDialog.getByRole('button',{name:'Confirm acceptance'}).click();
  const receipt = page.getByRole('region', { name: 'Quote acceptance receipt' });await expect(receipt).toContainText('Service agreement 46464646 established for Civic Events Limited.');await receipt.getByRole('button',{name:'Open service agreement'}).click();
  await expect(page).toHaveURL(/\/admin\/relationships\?account=40404040-4040-4040-8040-404040404040&agreement=46464646-4646-4646-8646-464646464646$/);await expect(page.getByText('Civic Events Limited service proposal',{exact:true})).toBeVisible(); expect(errors, errors.join('\n')).toEqual([]);
});

test('account team manages contacts, follow-up activity, and receivables', async ({ page }) => {
  const errors = monitorBrowserErrors(page); await signInAsAdmin(page, '/admin/crm');
  const client = page.getByText('Civic Events Limited', { exact: true }).locator('..').locator('..');
  await client.getByRole('button', { name: 'Manage account' }).click();
  const workspace = page.getByRole('dialog', { name: 'Civic Events Limited' });
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
  await expect(workspace).toHaveScreenshot('crm-account-workspace.png');
  await workspace.getByRole('button', { name: 'Close account workspace' }).click();

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

test('administrator creates and edits organizations through the human account spine', async ({ page }) => {
  const errors = monitorBrowserErrors(page); await signInAsAdmin(page, '/admin/crm');

  await page.getByRole('button', { name: 'Add organization' }).click();
  let dialog = page.getByRole('dialog', { name: 'Find or add an organization' });
  await dialog.getByLabel('Organization name').fill('Civic Events');
  await dialog.getByRole('button', { name: 'Search organizations' }).click();
  await expect(dialog.getByText('Possible matches')).toBeVisible();
  await expect(dialog.getByText('Civic Events Limited', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Managed account/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Close organization dialog' }).click();

  await page.getByRole('button', { name: 'Add organization' }).click();
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
  await expect(created.getByText(/Add the primary contact next/)).toBeVisible();
  await created.getByRole('button', { name: 'Add primary contact' }).click();

  const workspace = page.getByRole('dialog', { name: 'Harbour Arts Trust' });
  await workspace.getByRole('button', { name: 'Add contact' }).click();
  await workspace.getByLabel('First name').fill('Hana'); await workspace.getByLabel('Last name').fill('Te Aho');
  await workspace.getByLabel('Role or title').fill('Venue Manager'); await workspace.getByLabel('Email').fill('hana@harbourarts.test');
  await workspace.getByText('Primary contact', { exact: true }).click();
  await workspace.getByRole('button', { name: 'Add contact', exact: true }).last().click();
  await expect(workspace.getByText('Hana Te Aho')).toBeVisible();
  await workspace.getByRole('button', { name: 'Close account workspace' }).click();

  const prospect = page.getByText('Harbour Arts Trust', { exact: true }).locator('..').locator('..');
  await expect(prospect.getByText('prospect · 0 sites')).toBeVisible();
  await expect(prospect.getByText('Add covered site')).toBeVisible();
  await prospect.getByRole('button', { name: 'Add site' }).click();
  const siteSearch = page.getByRole('dialog', { name: 'Find a site for Harbour Arts Trust' });
  await siteSearch.getByLabel('Site name').fill('Harbour Arts Centre');
  await siteSearch.getByLabel('Street address').fill('8 Haven Road, Nelson');
  await siteSearch.getByRole('button', { name: 'Search sites' }).click();
  await expect(siteSearch.getByText('No matching sites found')).toBeVisible();
  await siteSearch.getByRole('button', { name: 'Create new site' }).click();
  const siteCreate = page.getByRole('dialog', { name: 'Create site for Harbour Arts Trust' });
  await expect(siteCreate.getByText(/provisional, unverified boundary/)).toBeVisible();
  await siteCreate.getByRole('button', { name: 'Create site for boundary review' }).click();
  await expect(page.getByRole('status')).toContainText('Harbour Arts Centre created with a provisional boundary');
  await expect(prospect.getByText('prospect · 1 site')).toBeVisible();
  await expect(prospect.getByText('Create service agreement')).toBeVisible();

  const civic = page.getByText('Civic Events Limited', { exact: true }).locator('..').locator('..');
  await civic.getByRole('button', { name: 'Edit organization' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Civic Events Limited' });
  await expect(edit.getByLabel('NZBN')).toHaveValue('9429041234567');
  await edit.getByLabel('Account context').fill('Annual events programme with confirmed winter operations.');
  await edit.getByRole('button', { name: 'Save organization' }).click();
  await expect(page.getByRole('status')).toContainText('Civic Events Limited organization details updated');
  expect(errors, errors.join('\n')).toEqual([]);
});