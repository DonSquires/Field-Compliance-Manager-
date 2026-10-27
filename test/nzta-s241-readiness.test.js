const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261101160000_nzta_s241_readiness.sql'), 'utf8');
const fn = name => {
  const start = migration.search(new RegExp(`CREATE (OR REPLACE )?FUNCTION "?public"?\\."?${name}"?\\(`));
  assert.ok(start >= 0, name);
  return migration.slice(start, migration.indexOf('$function$;', start) + '$function$;'.length);
};

const PUBLIC_RPCS = [
  'record_nzta_register_lookup', 'set_nzta_register_lookup_outcome', 'list_nzta_register_lookups', 'reveal_nzta_registered_person',
  'list_nzta_register_access_log', 'record_nzta_access_attestation', 'withdraw_nzta_access_attestation', 'get_nzta_access_holders',
  'record_nzta_access_review', 'list_nzta_access_reviews', 'get_nzta_s241_summary', 'get_vehicle_identity_checks',
];

test('anonymous callers lose canonical person reads', () => {
  assert.match(migration, /REVOKE SELECT ON public\.canonical_person_public FROM anon;/);
});

test('lookups are limited to the two Gazette purposes and reveals add only notice follow-up', () => {
  assert.match(migration, /purpose text NOT NULL CHECK \(purpose IN \('trespass_unpermitted_vehicle', 'cctv_patrol_signage_breach'\)\)/);
  assert.match(migration, /CHECK \(purpose IN \('trespass_unpermitted_vehicle', 'cctv_patrol_signage_breach', 'notice_follow_up'\)\)/);
  assert.doesNotMatch(migration, /permit_vetting|general_investigation/);
});

test('register tables are RLS-protected and written only through definer RPCs', () => {
  for (const table of ['nzta_register_lookups', 'nzta_register_access_log', 'nzta_access_attestations', 'nzta_access_reviews']) {
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY;`));
    assert.match(migration, new RegExp(`CREATE POLICY ${table}_select ON public\\.${table} FOR SELECT TO authenticated`));
    assert.doesNotMatch(migration, new RegExp(`CREATE POLICY [^ ]+ ON public\\.${table} FOR (INSERT|UPDATE|DELETE|ALL)`));
  }
  assert.match(migration, /REVOKE ALL ON public\.nzta_register_lookups, public\.nzta_register_access_log,/);
});

test('every new RPC is a hardened definer, revoked by default and granted only to signed-in users', () => {
  for (const name of PUBLIC_RPCS) {
    const body = fn(name);
    assert.match(body, /SECURITY DEFINER/, name);
    assert.match(body, /SET search_path(?: TO |\s*=\s*)''/, name);
    assert.match(body, /auth\.uid\(\)/, name);
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^;]*\\) FROM PUBLIC, anon, authenticated, service_role;`), name);
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^;]*\\) TO authenticated`), name);
    assert.doesNotMatch(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^;]*\\) TO [^;]*anon`), name);
  }
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.nzta_access_readiness\([^;]*\) FROM PUBLIC, anon, authenticated, service_role;/);
  assert.doesNotMatch(migration, /GRANT EXECUTE ON FUNCTION public\.nzta_access_readiness\(/);
  // RLS expressions run as the caller; the reveal check reports only the caller's own window.
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.nzta_reveal_active\([^;]*\) FROM PUBLIC, anon, authenticated, service_role;/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.nzta_reveal_active\(uuid\[\], text, uuid\) TO authenticated;/);
  assert.doesNotMatch(migration, /GRANT EXECUTE ON FUNCTION public\.nzta_reveal_active\([^;]*\) TO [^;]*anon/);
  assert.match(fn('nzta_reveal_active'), /log\.actor_user_id = auth\.uid\(\)/);
});

test('direct table reads cannot bypass the reveal', () => {
  const links = migration.slice(migration.indexOf('ALTER POLICY entity_links_select'));
  assert.match(links.slice(0, links.indexOf(';')), /nzta_restricted[\s\S]*nzta_reveal_active\(ARRAY\[organization_id\], 'vehicle', to_id\)[\s\S]*nzta_reveal_active\(ARRAY\[organization_id\], 'person', from_id\)/);
  const documents = migration.slice(migration.indexOf('ALTER POLICY person_identity_documents_select'));
  assert.match(documents.slice(0, documents.indexOf(';')), /document_kind IS DISTINCT FROM 'nzta_mvr_record'/);
});

test('unrevealed identity checks return only allow-listed vehicle facts', () => {
  const checks = fn('get_vehicle_identity_checks');
  assert.match(checks, /CASE WHEN v_revealed THEN checks\.vehicle_snapshot\s+ELSE \(SELECT coalesce\(jsonb_object_agg\(key, value\)/);
  const allowList = checks.slice(checks.indexOf("WHERE key IN"), checks.indexOf(')) END'));
  assert.doesNotMatch(allowList, /display_name|name'|date_of_birth|address|email|phone/);
});

test('readiness follows the person, and holders mirror administrator reach', () => {
  assert.match(fn('nzta_access_readiness'), /SELECT profile\.organization_id FROM public\.user_profiles profile WHERE profile\.id = p_user_id/);
  const holders = fn('get_nzta_access_holders');
  assert.match(holders, /profile\.role = 'grand_master'/);
  assert.match(holders, /get_descendant_organizations\(profile\.organization_id\)/);
  assert.match(holders, /service_agreements/);
  assert.match(holders, /'holds_access'/);
  assert.match(fn('get_nzta_s241_summary'), /WHERE \(h->>'holds_access'\)::boolean/);
  assert.match(fn('record_nzta_access_review'), /WHERE \(h->>'holds_access'\)::boolean/);
});

test('reveal is purpose-stated, explained, logged and time-boxed', () => {
  const reveal = fn('reveal_nzta_registered_person');
  assert.match(reveal, /can_access_vehicle_owner_identity/);
  assert.match(reveal, /INSERT INTO public\.nzta_register_access_log/);
  assert.match(reveal, /interval '15 minutes'/);
  assert.match(reveal, /length\(btrim\(coalesce\(p_explanation, ''\)\)\) < 10/);
  assert.match(reveal, /notice_follow_up/);
});

test('NZTA person links stay masked until an open reveal', () => {
  assert.match(fn('get_vehicle_owner_links'), /nzta_reveal_active/);
  assert.match(fn('get_vehicle_identity_checks'), /nzta_reveal_active/);
  assert.match(fn('search_people'), /nzta_reveal_required/);
  assert.match(fn('search_people'), /nzta_reveal_active/);
});

test('new vehicle-owner grants need current training and confidentiality; annual expiry is capped', () => {
  assert.match(fn('set_vehicle_owner_access'), /nzta_access_readiness/);
  assert.match(fn('record_nzta_access_attestation'), /interval '12 months'/);
});

test('retention is reported, never deleted, by this migration', () => {
  const summary = fn('get_nzta_s241_summary');
  assert.match(summary, /checks_older_than_18_months/);
  for (const kind of ['lookups', 'reveals']) {
    for (const age of ['18_months', '2_years', '5_years']) assert.match(summary, new RegExp(`${kind}_older_than_${age}`));
  }
  assert.doesNotMatch(migration, /\bDELETE FROM public\.(vehicle_identity_checks|nzta_)/);
});
