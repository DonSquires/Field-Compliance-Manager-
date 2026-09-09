const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const brief = fs.readFileSync(path.join(root, 'docs/FCM_PLATFORM_ARCHITECTURE_BRIEF.md'), 'utf8');
const sites = fs.readFileSync(path.join(root, 'supabase/schemas/public/tables/client_sites.sql'), 'utf8');
const zones = fs.readFileSync(path.join(root, 'supabase/schemas/public/tables/location_zones.sql'), 'utf8');

test('FCM architecture brief preserves the shared organization and place spine', () => {
  for (const term of [
    'field operations and compliance platform',
    'organizations',
    'client_sites',
    'location_zones',
    'location_events',
    'Bob',
    'human approval',
    'evidence and event provenance',
  ]) {
    assert.match(brief, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
  assert.match(sites, /client_organization_id/);
  assert.match(sites, /client_sites_client_organization_id_fkey/);
  assert.match(zones, /"organization_id"\s+uuid/);
});
