const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (relativePath) => fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');
const workspace = read('apps/web/src/components/FinanceApplyWorkspace.tsx');
const crm = read('apps/web/src/pages/CRMPage.tsx');
const sendInvoice = read('supabase/functions/send-invoice/index.ts');

test('Akahu Apply workspace verifies provider readiness before case work', () => {
  assert.match(workspace, /supabase\.functions\.invoke\('finance-akahu-apply-org'/);
  assert.match(workspace, /Provider ready: \{applyOrganization\.name\}/);
  assert.match(workspace, /const providerReady = Boolean\(applyOrganization\) && !providerNotConfigured;/);
  assert.match(workspace, /disabled=\{saving \|\| !reference\.trim\(\) \|\| !providerReady\}/);
  assert.match(workspace, /Akahu Apply is not connected for this platform yet/);
  assert.doesNotMatch(workspace, /disabled=\{[^}]*!applyOrganization\}/);
});

test('CRM invoice send performs real delivery instead of status-only transition', () => {
  assert.match(crm, /invoiceAction\.action === 'send'/);
  assert.match(crm, /supabase\.functions\.invoke\('send-invoice', \{ body: \{ invoice_id: invoiceAction\.invoice\.id \} \}\)/);
  assert.doesNotMatch(crm, /sent to accounts receivable/);
});

test('invoice delivery derives the governed recipient and fails loudly on partial completion', () => {
  assert.match(sendInvoice, /if \(req\.method !== 'POST'\)/);
  assert.match(sendInvoice, /inv\.status !== 'draft' \|\| inv\.sent_at/);
  assert.match(sendInvoice, /select\('name,billing_email'\)/);
  assert.doesNotMatch(sendInvoice, /body\.to/);
  assert.match(sendInvoice, /escapeHtml\(inv\.notes\)/);
  assert.match(sendInvoice, /\.eq\('status', 'draft'\)\.is\('sent_at', null\)/);
  assert.match(sendInvoice, /invoice_email_delivered/);
  assert.match(sendInvoice, /Email may have been delivered, but invoice state could not be confirmed/);
});
