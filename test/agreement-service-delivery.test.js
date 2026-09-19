const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260919120000_agreement_service_delivery.sql'), 'utf8');
const page = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/ClientPortalPage.tsx'), 'utf8');
const access = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/lib/clientPortalAccess.ts'), 'utf8');
const shell = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/shells/ClientShell.tsx'), 'utf8');

const assembler = migration.slice(migration.indexOf('create or replace function public.agreement_service_delivery'), migration.indexOf('create or replace function public.get_agreement_service_delivery'));
const read = migration.slice(migration.indexOf('create or replace function public.get_agreement_service_delivery'), migration.indexOf('create or replace function public.generate_due_report_packs'));
const packs = migration.slice(migration.indexOf('create or replace function public.generate_due_report_packs'));

test('delivery is counted only at the agreement\'s places, from the provider (and its branches), for shifts already due', () => {
  assert.match(assembler, /where sal\.service_agreement_id = v_agreement\.id and sal\.status = 'active'/);
  assert.match(assembler, /join places p on \(p\.site_id is not null and p\.site_id = ss\.site_id\) or \(p\.zone_id is not null and p\.zone_id = ss\.zone_id\)/);
  assert.match(assembler, /v_providers := public\.get_descendant_organizations\(v_agreement\.provider_organization_id\);/);
  assert.match(assembler, /where sh\.organization_id = any\(v_providers\)\n\s+and sh\.status <> 'cancelled'\n\s+and sh\.scheduled_start >= v_start\n\s+and sh\.scheduled_start < least\(v_end, now\(\)\)/);
  assert.match(assembler, /count\(st\.id\) filter \(where st\.module_key = 'static_guarding' and st\.actual_arrived_at is not null\) as post_attended/);
  assert.match(assembler, /coalesce\(st\.actual_departed_at, st\.actual_end, now\(\)\) - st\.actual_arrived_at/);
  // no officer identities leave the assembler
  assert.doesNotMatch(assembler, /officer_user_id|display_name|staff_id/);
  assert.match(assembler, /revoke all on function public\.agreement_service_delivery\(uuid, date, date\) from public, anon, authenticated, service_role;/);
});

test('the client-facing read is authorised to the agreement\'s client (portal on) and the provider\'s administrators or branch managers only', () => {
  assert.match(read, /p_period_end - p_period_start > 92/);
  assert.match(read, /public\.is_admin_for_org\(v_agreement\.provider_organization_id\)/);
  assert.match(read, /a\.role_at_branch in \('branch_manager', 'admin', 'master'\)/);
  assert.doesNotMatch(read, /user_can_operate_organization|org_access_allowed/);
  assert.match(read, /v_profile\.organization_id = v_agreement\.client_organization_id\n\s+and v_profile\.role in \('client_admin', 'client_officer', 'client_viewer', 'master', 'admin'\)\n\s+and v_agreement\.client_portal_access_mode in \('transparency_only', 'full_modules'\)/);
  assert.match(read, /raise exception 'Not authorised to view delivery for this agreement'/);
  assert.match(read, /grant execute on function public\.get_agreement_service_delivery\(uuid, date, date\) to postgres, authenticated, service_role;/);
});

test('the report pack\'s facilities are this agreement\'s places, and branch-held agreements are generated too', () => {
  assert.match(packs, /where provider_organization_id = any\(public\.get_descendant_organizations\(v_provider\)\)/);
  assert.match(packs, /v_delivery := public\.agreement_service_delivery\(v_agreement\.id, p_period_start, p_period_end\);/);
  assert.match(packs, /'siteName', place->>'place_name', 'expected', \(place->>'patrol_expected'\)::integer \+ \(place->>'post_expected'\)::integer, 'completed', \(place->>'patrol_completed'\)::integer \+ \(place->>'post_attended'\)::integer/);
  assert.doesNotMatch(packs, /FROM public\.shift_stops ss\s+LEFT JOIN public\.client_sites cs ON cs\.id = ss\.site_id\s+WHERE ss\.organization_id = v_agreement\.provider_organization_id/i);
  assert.match(packs, /'facilities', v_facilities,\n\s+'delivery', v_delivery/);
});

test('the client portal offers Service delivered in every operational mode and says it plainly', () => {
  assert.match(access, /if \(access\.mode === 'transparency_only' \|\| access\.mode === 'full_modules'\) pages\.add\('delivery'\);/);
  assert.match(shell, /\{ id: 'delivery', label: 'Service delivered', icon: Shield \}/);
  assert.match(page, /supabase\.rpc\('get_agreement_service_delivery', \{ p_agreement_id: agreement\.id, p_period_start: bounds\.start, p_period_end: bounds\.end \}\)/);
  assert.match(page, /if \(!agreement \|\| !allowedPages\.has\('delivery'\)\) \{ setDelivery\(null\); return; \}/);
  const words = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/lib/serviceDelivery.ts'), 'utf8');
  assert.match(words, /of \$\{plural\(place\.patrol_expected, 'contracted visit'\)\} done/);
  assert.match(words, /\$\{plural\(place\.post_attended, 'guard attendance'\)\} of \$\{place\.post_expected\} rostered · \$\{hoursOnPost\(place\.post_minutes\)\} on post/);
  assert.match(words, /'No presence recorded in this period'/);
  assert.match(page, /Only shifts already due are counted; the names of individual officers are not shown here\./);
});

const crmPanel = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/components/CrmAgreementDeliveryPanel.tsx'), 'utf8');
const workspace = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/components/CrmAccountWorkspace.tsx'), 'utf8');
const lib = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/lib/serviceDelivery.ts'), 'utf8');
const handoff = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/components/CrmRosterHandoffPanel.tsx'), 'utf8');

test('the provider reads the same delivery numbers inside the Client Portfolio, and a stub or empty payload never crashes the card', () => {
  assert.match(workspace, /<CrmRosterHandoffPanel agreement=\{agreement\} onChanged=\{loadWorkspace\} \/><CrmAgreementDeliveryPanel agreementId=\{agreement\.id\} \/>/);
  assert.match(crmPanel, /supabase\.rpc\('get_agreement_service_delivery', \{ p_agreement_id: agreementId, p_period_start: bounds\.start, p_period_end: bounds\.end \}\)/);
  assert.match(crmPanel, /const parsed = asDeliverySummary\(data\);/);
  assert.match(page, /const parsed = asDeliverySummary\(data\);/);
  assert.match(lib, /if \(!data \|\| typeof data !== 'object' \|\| Array\.isArray\(data\)\) return null;/);
  assert.match(crmPanel, /The client can see these gaps too\. Check the roster and the officers' shift records before the monthly report goes out\./);
  // the handoff list says the slot's real state, not "Shift live" for a finished shift
  assert.match(handoff, /slot\.status === 'completed' \? 'Completed' : slot\.linked_shift_id \? `\$\{slotStatusLabel\(slot\.status\)\} · shift created` : slotStatusLabel\(slot\.status\)/);
  assert.doesNotMatch(handoff, /'Shift live'/);
});
