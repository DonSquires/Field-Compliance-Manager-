const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (relative) => fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');
const plainPath = read('supabase/migrations/20260920200000_client_setup_plain_path.sql');
const ruling = read('supabase/migrations/20260920210000_readiness_and_activation_follow_the_ruling.sql');
const canon = read('docs/canon/ORG_SERVICE_MODEL.md');
const wizard = read('apps/web/src/pages/ClientSetupPage.tsx');
const shell = read('apps/web/src/shells/AdminShell.tsx');
const crmPage = read('apps/web/src/pages/CRMPage.tsx');
const ledger = read('apps/web/src/pages/AccountOnboardingPage.tsx');
const workPanel = read('apps/web/src/components/CrmOperationalWorkPanel.tsx');
const handoffPanel = read('apps/web/src/components/CrmRosterHandoffPanel.tsx');
const onboardingPanel = read('apps/web/src/components/CrmOnboardingPanel.tsx');

test('the ruling is recorded in canon before the code stands: configuring happens on the provider\'s live agreement; acceptance is portal access', () => {
  assert.match(canon, /## Ruling 2026-09-21 — configuring before acceptance/);
  assert.match(canon.replace(/\s+/g, ' '), /The client's acceptance of the invitation grants \*\*portal access\*\*; it is not the provider's permission to configure\./);
});

test('one governed writer per step of the guided setup, over the existing spine', () => {
  assert.match(plainPath, /ADD COLUMN IF NOT EXISTS delivery_schedule_id uuid REFERENCES public\.service_agreement_delivery_schedules\(id\) ON DELETE SET NULL/);
  assert.match(plainPath, /CREATE OR REPLACE FUNCTION public\.ensure_crm_client_agreement\(p_account_organization_id uuid, p_provider_organization_id uuid DEFAULT NULL\)/);
  assert.match(plainPath, /CREATE OR REPLACE FUNCTION public\.manage_crm_agreement_delivery_schedule\(/);
  // the two paths (quote acceptance and direct schedule) meet on the same link, and every reader joins on either
  assert.match(plainPath, /c\.delivery_schedule_id = s\.id OR \(c\.proposal_scope_schedule_id IS NOT NULL AND s\.proposal_scope_schedule_id = c\.proposal_scope_schedule_id\)/);
  assert.match(wizard, /supabase\.rpc\('manage_crm_organization'/);
  assert.match(wizard, /supabase\.rpc\('manage_crm_contact'/);
  assert.match(wizard, /supabase\.rpc\('create_crm_site'/);
  assert.match(wizard, /const row = \(Array\.isArray\(data\) \? data\[0\] : data\)/);
  assert.match(wizard, /supabase\.rpc\('ensure_crm_client_agreement', \{ p_account_organization_id: client\.id, p_provider_organization_id: branchId \}\)/);
  assert.match(wizard, /supabase\.rpc\('manage_crm_agreement_delivery_schedule', \{/);
  assert.match(wizard, /supabase\.rpc\('create_patrol_route_from_agreement', \{ p_client_request_id: crypto\.randomUUID\(\), p_service_agreement_id: id, p_name: `\$\{client\.name\} patrol run`, p_operating_organization_id: branchId \}\)/);
  assert.match(wizard, /supabase\.rpc\('create_operating_roster_work_unit', \{ p_operating_organization_id: branchId,/);
  assert.doesNotMatch(wizard, /create_operating_roster_work_unit', \{ p_client_request_id/);
});

test('readiness and activation no longer wait for the client\'s portal acceptance, and speak plainly', () => {
  assert.match(ruling, /AND sa\.agreement_type = 'operational'\s+AND \(sa\.ends_on IS NULL OR sa\.ends_on >= current_date\)\s+\) AS agreement_ready,/);
  assert.match(ruling, /'ready',v_location_count>0 and v_boundary_ready/);
  assert.match(ruling, /IF NOT FOUND THEN RAISE EXCEPTION 'Live operational agreement required'; END IF;/);
  assert.doesNotMatch(ruling, /invitation_status <> 'accepted'/);
  for (const words of ['Add the person we deal with', 'Add a place we work at', 'Set up the service agreement', 'Add a service (what we do there)', 'Set a price: a rate or an accepted quote', 'Build the patrol run or guard post', 'Ready to activate']) {
    assert.ok(ruling.includes(words), words);
  }
  assert.doesNotMatch(workPanel, /invitation_status !== 'accepted'/);
  assert.doesNotMatch(handoffPanel, /invitation_status !== 'accepted'/);
  assert.match(onboardingPanel, /Client login sent \(optional\)/);
});

test('the guided setup is reachable where a person would look, and the field-only banner stays off desk pages', () => {
  assert.match(shell, /\{ id: 'client-setup', label: 'Set up a new client', icon: ClipboardCheck \}/);
  assert.match(shell, /\{ id: 'onboarding', label: 'Clients being set up', icon: ClipboardCheck \}/);
  assert.match(shell, /case 'client-setup':\s+return <ClientSetupPage onNavigate=/);
  assert.match(shell, /const FIELD_CONTEXT_PAGES = new Set<AdminPage>\(\['field-ops', 'site-360', 'locations', 'zones', 'sites', 'workshop', 'investigations'\]\);/);
  assert.match(shell, /\{showPlaceContext && <PlaceContextBanner \/>\}/);
  assert.match(crmPage, /onClick=\{\(\) => onNavigate\('client-setup'\)\}>Set up a new client<\/button>/);
  assert.match(ledger, /<h1>Clients being set up<\/h1>/);
  assert.match(ledger, /onClick=\{\(\) => onNavigate\('client-setup'\)\}/);
  // plain words on the steps and the read-back sentence
  for (const words of ['Who is the client?', 'Where do we work for', 'What do we do there?', 'Who logs in for', 'What happens next', 'Any time of day (24-hour)', 'Five short steps. Each one saves as you go, so you can stop and come back.']) {
    assert.ok(wizard.includes(words), words);
  }
});
