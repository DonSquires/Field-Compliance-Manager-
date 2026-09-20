const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (relative) => fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');
const endMigration = read('supabase/migrations/20260920080000_end_service_agreement.sql');
const quoteRls = read('supabase/migrations/20260920090000_quote_visibility_follows_org_reach.sql');
const patrolRun = read('supabase/migrations/20260920100000_patrol_run_belongs_to_the_branch.sql');
const term = read('apps/web/src/components/CrmAgreementTerm.tsx');
const workspace = read('apps/web/src/components/CrmAccountWorkspace.tsx');
const crmPage = read('apps/web/src/pages/CRMPage.tsx');
const workPanel = read('apps/web/src/components/CrmOperationalWorkPanel.tsx');

test('an agreement can end: governed writer, reason required, cancel-before-start allowed, and only live agreements drive onboarding', () => {
  assert.match(endMigration, /create or replace function public\.end_service_agreement\(p_agreement_id uuid, p_ends_on date, p_reason text\)/);
  assert.match(endMigration, /if not found or not public\.is_admin_for_org\(v_before\.provider_organization_id\) then raise exception 'Service agreement not found or access denied'/);
  assert.match(endMigration, /p_ends_on < v_before\.starts_on - 1 then raise exception 'The agreement cannot end before it started \(%\)\. To cancel one that never took effect, end it the day before it started\.'/);
  assert.match(endMigration, /char_length\(trim\(coalesce\(p_reason, ''\)\)\) not between 3 and 500/);
  assert.match(endMigration, /'service_agreement_ended', 'service_agreements', v_before\.id/);
  // the onboarding workspace, the review gate, activation and the invitation look at live agreements only
  assert.match(endMigration, /AND a\.agreement_type = 'operational'\s+AND \(a\.ends_on IS NULL OR a\.ends_on >= current_date\)/);
  assert.match(endMigration, /AND sa\.invitation_status = 'accepted'\s+AND \(sa\.ends_on IS NULL OR sa\.ends_on >= current_date\)/);
  assert.match(endMigration, /This agreement has ended; activate the account on a live agreement/);
  assert.match(endMigration, /AND agreement_type = 'operational'\s+AND \(ends_on IS NULL OR ends_on >= current_date\)/);
});

test('the agreement card reads its term in plain words and ends it with a reason', () => {
  assert.match(term, /if \(state === 'cancelled'\) return 'Cancelled before it took effect';/);
  assert.match(term, /if \(state === 'ended'\) return `Ended \$\{dayWords\(agreement\.ends_on!\)\}`;/);
  assert.match(term, /supabase\.rpc\('end_service_agreement', \{ p_agreement_id: agreement\.id, p_ends_on: endsOn, p_reason: reason\.trim\(\) \}\)/);
  assert.match(term, /Ending stops new quotes, invitations and activation on this agreement from the day after the end date\. Work already rostered or delivered stays on record\./);
  assert.match(workspace, /<CrmAgreementTerm agreement=\{agreement\} canEnd=\{agreement\.agreement_type === 'operational' && agreement\.client_organization_id === account\.id\} onEnded=\{loadWorkspace\} \/>/);
  // setup and operational panels only while the agreement is live
  assert.match(workspace, /agreement\.client_organization_id === account\.id && live && <><button type="button" onClick=\{\(\) => setSetupAgreement\(agreement\)\}>Configure coverage and modules<\/button>/);
});

test('quote visibility follows organisation reach, not the caller\'s home organisation', () => {
  assert.match(quoteRls, /create policy quotes_select on public\.quotes for select\s+using \(public\.is_grand_master\(\) or public\.org_access_allowed\(provider_org_id\)\);/);
  assert.match(quoteRls, /create policy quotes_write on public\.quotes\s+using \(public\.is_grand_master\(\) or public\.is_admin_for_org\(provider_org_id\)/);
  assert.match(quoteRls, /create policy quote_lines_select on public\.quote_lines for select\s+using \(exists \(select 1 from public\.quotes q where q\.id = quote_lines\.quote_id and \(public\.is_grand_master\(\) or public\.org_access_allowed\(q\.provider_org_id\)\)\)\);/);
  assert.doesNotMatch(quoteRls, /provider_org_id IN \( SELECT up\.organization_id\s+FROM user_profiles up\s+WHERE \(up\.id = auth\.uid\(\)\)\)\)\)$/m);
});

test('the quote dialog waits for the existing-agreement check, warns when nothing operational would follow, and drafts can be reopened', () => {
  assert.match(crmPage, /const \[quoteAgreementsChecked, setQuoteAgreementsChecked\] = useState\(false\);/);
  assert.match(crmPage, /disabled=\{quoteSaving \|\| !quoteAgreementsChecked \|\|/);
  assert.match(crmPage, /Checking whether \{quoteClient\.name\} already has a live agreement this quote should vary/);
  assert.match(crmPage, /quotedModuleKeys\.length > 0 && \(proposalServiceScopes\.length === 0 \|\| proposalScopeSchedules\.length === 0\) && <p className="crm-lifecycle-warning" role="alert">/);
  assert.match(crmPage, /nothing will be rostered from it until a variation adds the places and times/);
  assert.match(crmPage, /Variation accepted on \$\{quoteAcceptance\.variedAgreementName\}; its prices and any new places now apply\./);
  assert.match(crmPage, /const reopenQuote = async \(account: CrmWorkspaceAccount, quote: WorkspaceQuote\) => \{/);
  assert.match(workspace, /\{quote\.status === 'draft' \? 'Continue pricing' : 'Open quote'\}/);
});

test('a patrol run belongs to the delivering branch; stop modules inherit the schedule module; readiness counts patrol runs', () => {
  assert.match(patrolRun, /create or replace function public\.create_patrol_route_from_agreement\(p_client_request_id uuid, p_service_agreement_id uuid, p_name text default null, p_operating_organization_id uuid default null\)/);
  assert.match(patrolRun, /raise exception 'The operating branch must be the agreement holder or one of its branches'/);
  assert.match(patrolRun, /and cspc\.organization_id = v_operating\s+and cspc\.active;/);
  assert.match(patrolRun, /values \(\s*v_operating,\s*coalesce\(v_name, v_agreement\.name \|\| ' patrol run'\)/);
  assert.match(patrolRun, /order by case when sam\.module_key = v_schedule_module then 0 when sam\.module_key = v_config\.module_key then 1 else 2 end/);
  assert.match(patrolRun, /or exists \(select 1 from public\.client_site_patrol_config c join public\.service_agreement_delivery_schedules s on s\.proposal_scope_schedule_id=c\.proposal_scope_schedule_id\s+where c\.patrol_route_id=wu\.patrol_route_id and c\.active and s\.service_agreement_id=v_agreement\.id and s\.active\)\);/);
  // the panel reads routes and work units across the holder's house and creates patrol units at the route's branch
  assert.match(workPanel, /supabase\.rpc\('get_descendant_organizations', \{ org_id: agreement\.provider_organization_id \}\)/);
  assert.match(workPanel, /p_operating_organization_id: \(isPatrol \? routes\.find\(\(route\) => route\.id === form\.routeId\)\?\.organization_id : null\) \?\? agreement\.provider_organization_id,/);
});

test("the account's readiness and next action count a patrol run, and an active account is told to roster and deliver", () => {
  const orgReadiness = read('supabase/migrations/20260920110000_account_readiness_counts_patrol_runs.sql');
  const activeNext = read('supabase/migrations/20260920120000_active_account_next_action.sql');
  assert.match(orgReadiness, /OR sa\.id IN \(SELECT s\.service_agreement_id FROM public\.client_site_patrol_config c JOIN public\.service_agreement_delivery_schedules s ON s\.proposal_scope_schedule_id = c\.proposal_scope_schedule_id WHERE c\.patrol_route_id = wu\.patrol_route_id AND c\.active AND s\.active\)/);
  assert.match(orgReadiness, /AND \(sa\.ends_on IS NULL OR sa\.ends_on >= current_date\)\s+AND wu\.active/);
  assert.match(activeNext, /WHEN f\.status = 'active' AND f\.contact_ready AND f\.location_ready AND f\.agreement_ready AND f\.module_ready AND f\.billing_ready AND f\.operations_ready THEN 'Active: roster the work units and deliver'/);
  // the portfolio re-reads readiness on every load and headlines the live agreement
  assert.match(workspace, /supabase\.rpc\('get_crm_organization_readiness', \{ p_organization_ids: \[account\.id\] \}\)/);
  assert.match(workspace, /const liveOperational = agreements\.filter\(\(agreement\) => agreement\.agreement_type === 'operational' && \['live', 'ending'\]\.includes\(agreementTermState\(agreement\)\)\);/);
});
