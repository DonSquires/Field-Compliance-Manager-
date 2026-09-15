const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const migration = read('supabase/migrations/20260915170000_place_model_convergence.sql');
const oracle = read('supabase/tests/20260915170000_place_model_convergence.sql');
const edgeKey = read('supabase/functions/_shared/addressKey.ts');
const houseResolve = read('supabase/functions/_shared/houseResolve.ts');
const upsertEntity = read('supabase/functions/bob-upsert-entity/index.ts');
const proposalExecute = read('supabase/functions/bob-proposal-execute/index.ts');
const canon = read('docs/canon/LOCATION_HOUSE_MODEL.md');

// The SQL rule, executed in JS: lowercase, every run of non-alphanumerics removed, empty -> null.
const sqlRule = (address) => {
  const key = String(address ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  return key || null;
};

test('one address key rule: SQL helper is the pinned regex and every write path re-derives it', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.address_match_key\(p_address text\)/);
  assert.match(migration, /regexp_replace\(lower\(trim\(coalesce\(p_address, ''\)\)\), '\[\^a-z0-9\]\+', '', 'g'\)/);
  assert.match(migration, /CREATE TRIGGER zz_locations_place_identity BEFORE INSERT OR UPDATE ON public\.locations/);
  assert.match(migration, /CREATE TRIGGER zz_client_sites_place_house BEFORE INSERT OR UPDATE ON public\.client_sites/);
  assert.match(migration, /CREATE TRIGGER zz_location_zones_place_house BEFORE INSERT OR UPDATE ON public\.location_zones/);
  assert.ok((migration.match(/NEW\.address_match_key := public\.address_match_key\(NEW\.address\)/g) ?? []).length >= 2);
});

test('edge key helpers produce the SQL key shape (no whitespace-collapsed keys can be written or looked up)', () => {
  assert.match(edgeKey, /\.toLowerCase\(\)\.replace\(\/\[\^a-z0-9\]\+\/g, ''\)/);
  assert.match(upsertEntity, /\.toLowerCase\(\)\.replace\(\/\[\^a-z0-9\]\+\/g, ''\)/);
  assert.doesNotMatch(upsertEntity, /address\.toLowerCase\(\)\.replace\(\/\\s\+\/g, ' '\)\.trim\(\)/);
  const samples = ['  47 Example St, Nelson 7010 ', '37 Halifax Street', '159 Tahunanui Drive, Tāhunanui', '', null, '---'];
  const expected = [ '47examplestnelson7010', '37halifaxstreet', '159tahunanuidrivethunanui', null, null, null];
  samples.forEach((sample, index) => assert.equal(sqlRule(sample), expected[index]));
});

test('registry semantics: site keyed by address, zone keyed by house, facets inherit the house identity', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS canonical_place_id uuid REFERENCES public\.canonical_places\(id\) ON DELETE RESTRICT/);
  assert.match(migration, /ALTER TABLE public\.locations ALTER COLUMN canonical_place_id SET NOT NULL/);
  assert.match(migration, /'site:' \|\| p_key/);
  assert.match(migration, /v_kind \|\| ':' \|\| p_location_id::text/);
  assert.match(migration, /CHECK \(place_kind IN \('site', 'zone'\)\)/);
  assert.match(migration, /ALTER TABLE public\.client_sites ALTER COLUMN location_id SET NOT NULL/);
  assert.match(migration, /ALTER TABLE public\.location_zones ALTER COLUMN location_id SET NOT NULL/);
  assert.match(migration, /cannot hang off a house owned by another organisation/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS uq_locations_org_address_key/);
});

test('sibling facets: the zone->site link, zone nesting, zone address columns and the duplicate zone table are gone', () => {
  for (const column of ['site_id', 'parent_zone_id', 'boundary_legacy', 'repeat_stay_radius_meters', 'address', 'suburb', 'postcode', 'address_match_key']) {
    assert.match(migration, new RegExp(`DROP COLUMN IF EXISTS ${column}`));
  }
  assert.match(migration, /DROP TABLE IF EXISTS public\.client_site_zones/);
  assert.match(migration, /DROP FUNCTION IF EXISTS public\.get_zone_for_gps/);
  assert.doesNotMatch(migration, /z\.site_id|zone\.site_id|z\.parent_zone_id/);
  assert.doesNotMatch(proposalExecute, /zoneRow\.site_id|from\('location_zones'\)[^\n]*\.(eq|is)\('site_id'/);
  assert.doesNotMatch(proposalExecute, /'address',\s*'suburb',\s*'postcode'/);
});

test('permanence: deletes revoked and blocked, merges instead of deletes, purge is the one scoped exception', () => {
  assert.match(migration, /REVOKE DELETE, TRUNCATE ON public\.locations, public\.client_sites, public\.location_zones, public\.canonical_places, public\.canonical_place_links\s+FROM anon, authenticated/);
  for (const table of ['locations', 'client_sites', 'location_zones', 'canonical_places']) {
    assert.match(migration, new RegExp(`CREATE TRIGGER zz_place_permanence BEFORE DELETE ON public\\.${table} FOR EACH ROW EXECUTE FUNCTION public\\.tg_place_permanence\\(\\)`));
  }
  assert.match(migration, /current_setting\('app\.place_delete_scope', true\) = 'test_dataset_purge'/);
  assert.match(migration, /PERFORM set_config\('app\.place_delete_scope', 'test_dataset_purge', true\);/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.merge_canonical_place\(p_from uuid, p_into uuid\)/);
  assert.match(migration, /SET status = 'merged', merged_into_id = p_into/);
  assert.doesNotMatch(migration, /DELETE FROM public\.(locations|client_sites|location_zones|canonical_places)\b(?![\s\S]*purge_aam_e2e_dataset)/);
});

test('cross-organisation address is one registry place, not a conflict', () => {
  assert.doesNotMatch(houseResolve, /checkHouseConflictEdge\(admin, key, orgId\)/);
  assert.doesNotMatch(houseResolve, /throw new HouseConflictError\(/);
  assert.match(migration, /SELECT \* INTO v_location FROM public\.locations WHERE organization_id=p_organization_id AND address_match_key=v_address_key/);
  assert.doesNotMatch(migration, /A physical place with this address already exists/);
});

test('truth table and canon carry the ruling', () => {
  assert.match(oracle, /one place across organisations/);
  assert.match(oracle, /an established place cannot be deleted/);
  assert.match(oracle, /zone registry row is zone:<house id>/);
  assert.match(oracle, /resolve_context owner is the house org/);
  assert.match(canon, /## Owner ruling 2026-09-15/);
  assert.match(canon, /merge_canonical_place/);
});
