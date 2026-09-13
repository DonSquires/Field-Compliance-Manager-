const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/resolve-point-context/index.ts'), 'utf8');

test('point context verifies caller organization scope before privileged resolution', () => {
  const profileGate = source.indexOf(".select('role, organization_id, authorized_organization_ids, deactivated_at')");
  const resolverCall = source.indexOf("admin.rpc('resolve_context'");
  const privilegedSiteRead = source.indexOf("admin.from('client_sites')");

  assert.ok(profileGate > 0);
  assert.ok(profileGate < resolverCall);
  assert.ok(profileGate < privilegedSiteRead);
  assert.match(source, /callerProfile\.role === 'grand_master'/);
  assert.match(source, /authorizedOrganizations\.includes\(orgId\)/);
  assert.match(source, /callerProfile\.deactivated_at/);
  assert.match(source, /Forbidden: organization is outside your authorized scope/);
  assert.match(source, /if \(ctxErr\) return json\(\{[\s\S]*?Geofence context could not be resolved[\s\S]*?\}, 503\)/);
  assert.match(source, /if \(descendantsError\) return json\(\{[\s\S]*?Site organization scope could not be resolved/);
  assert.match(source, /if \(agreementsError\) return json\(\{[\s\S]*?Site agreement scope could not be resolved/);
  assert.match(source, /admin\.rpc\('resolve_verified_site_context'/);
  assert.match(source, /const moduleKey = body\.module_key/);
  assert.match(source, /p_module_key: moduleKey/);
  assert.match(source, /p_provider_org_id: orgId/);
  assert.match(source, /if \(siteContextError\) return json\(\{[\s\S]*?Verified Site context could not be resolved/);
  assert.doesNotMatch(source, /haversineM/);
  assert.doesNotMatch(source, /Non-fatal: continue to reverse geocoding/);
});