const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const hub = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/ReportsHubPage.tsx'), 'utf8');
const context = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/context/ServiceRelationshipContext.tsx'), 'utf8');
const pdfFn = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/generate-report-pack-pdf/index.ts'), 'utf8');
const sendFn = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/send-report-pack/index.ts'), 'utf8');

test('the service relationships of an employer organisation include the agreements its branches hold; a client sees only its own', () => {
  assert.match(context, /const isClientUser = profile\.role\.startsWith\('client_'\);/);
  assert.match(context, /supabase\.rpc\('get_descendant_organizations', \{ org_id: profile\.organizationId \}\)/);
  assert.match(context, /\.or\(isClientUser \? `client_organization_id\.eq\.\$\{profile\.organizationId\}` : `provider_organization_id\.in\.\(\$\{providerOrgIds\.join\(','\)\}\),client_organization_id\.eq\.\$\{profile\.organizationId\}`\)/);
});

test('the reports hub filters by an agreement the reader chooses, lists the whole house\'s packs, and calls the overview that exists', () => {
  assert.match(hub, /const \[agreementFilterId, setAgreementFilterId\] = useState\(''\);/);
  assert.match(hub, /<option value="">All agreements \(\{providerAgreements\.length\}\)<\/option>/);
  assert.match(hub, /\.in\('organization_id', houseOrgIds\)/);
  // a per-agreement overload never existed; calling it 404'd and failed the whole page
  assert.doesNotMatch(hub, /p_service_agreement_id: selectedAgreement/);
  assert.match(hub, /supabase\.rpc\('get_consolidated_reporting_overview', \{ p_root_organization_id: profile\.organizationId, p_from: dateRange\.start, p_to: dateRange\.end \}\)/);
  // PostgREST embeds a to-one relation as an object
  assert.match(hub, /\(Array\.isArray\(pack\.agreement\) \? pack\.agreement\[0\]\?\.name : pack\.agreement\?\.name\) \?\? 'Service agreement'/);
});

test('rendering and sending a report pack is authorised against the pack\'s organisation as the caller (branch-held packs)', () => {
  assert.match(pdfFn, /const \{ data: mayRender \} = await caller\.rpc\('is_admin_for_org', \{ target_org_id: pack\.organization_id \}\);/);
  assert.match(pdfFn, /if \(String\(profile\.role\) !== 'grand_master' && mayRender !== true\) return json\(\{ error: 'Forbidden' \}, 403\);/);
  assert.doesNotMatch(pdfFn, /pack\.organization_id !== profile\.organization_id/);
  assert.match(sendFn, /const \{ data: maySend \} = await callerClient\.rpc\('is_admin_for_org', \{ target_org_id: pack\.organization_id \}\);/);
  assert.doesNotMatch(sendFn, /pack\.organization_id !== callerProfile\.organization_id/);
});
