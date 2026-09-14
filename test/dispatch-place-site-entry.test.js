const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260914130000_dispatch_place_site_entry.sql'), 'utf8');
const oracle = fs.readFileSync(path.join(root, 'supabase/tests/20260914110000_noise_two_place_rls.sql'), 'utf8');

const helper = 'resolve_or_create_dispatch_place_site(uuid, uuid, text, text, double precision, double precision, uuid)';
const esc = (s) => s.replace(/[()]/g, '\\$&');

test('one internal resolve-or-create seam, callable only by the governed writers', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.resolve_or_create_dispatch_place_site\(/);
  assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${esc(helper)} FROM PUBLIC, anon, authenticated;`));
  assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${esc(helper)} TO service_role;`));
  assert.doesNotMatch(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${esc(helper)} TO authenticated`));
  assert.equal((migration.match(/SECURITY DEFINER SET search_path = public/g) || []).length, 3);
  assert.doesNotMatch(migration, /CREATE TABLE|ALTER TABLE|CREATE POLICY|DROP POLICY|DROP TABLE|CREATE TRIGGER/);
  // Both dispatch place writers ride the seam; neither keeps its own client_sites INSERT.
  assert.equal((migration.match(/FROM public\.resolve_or_create_dispatch_place_site\(/g) || []).length, 2);
  const helperBody = migration.slice(0, migration.indexOf('-- ── 2.'));
  const writers = migration.slice(migration.indexOf('-- ── 2.'));
  assert.match(helperBody, /INSERT INTO public\.client_sites \(/);
  assert.doesNotMatch(writers, /INSERT INTO public\.client_sites/);
  assert.doesNotMatch(writers, /INSERT INTO public\.locations/);
});

test('house first: dedup within the owner org, never reuse or fork another org\'s house, provisional centre only', () => {
  assert.match(migration, /SELECT h\.id INTO v_house_id FROM public\.locations h WHERE h\.organization_id = p_client_organization_id AND h\.address_match_key = v_key/);
  assert.match(migration, /ELSIF EXISTS \(SELECT 1 FROM public\.locations h WHERE h\.address_match_key = v_key\) THEN[\s\S]*?v_house_action := 'other_org_house';[\s\S]*?v_ownership := 'needs_review';/);
  assert.match(migration, /'house_conflict', 'other_org_house'/);
  assert.match(migration, /regexp_replace\(lower\(v_address\), '\[\^a-z0-9\]\+', '', 'g'\)/);
  assert.match(migration, /'adhoc', 'provisional', 'unverified', ST_SetSRID\(ST_MakePoint\(p_lng, p_lat\), 4326\), v_ownership, v_signals/);
  assert.doesNotMatch(migration, /'authoritative'|'verified'\)/, 'a resolved address never yields an authoritative or verified boundary');
  assert.match(migration, /WHERE cs\.client_organization_id = p_client_organization_id AND cs\.address_match_key = v_key[\s\S]*?FOR UPDATE/);
  assert.match(migration, /IF v_site\.location_id IS NULL AND v_house_id IS NOT NULL THEN\s+UPDATE public\.client_sites SET location_id = v_house_id/);
});

test('harmed-party site is bound to the job\'s client or custodian (it grants the W1 read) and address-only needs coordinates', () => {
  assert.match(migration, /DROP FUNCTION IF EXISTS public\.set_dispatch_job_harmed_party\(uuid, uuid, uuid, text, text, text, text, text, text\);/);
  assert.match(migration, /p_harmed_party_lat double precision DEFAULT NULL,\s+p_harmed_party_lng double precision DEFAULT NULL/);
  assert.match(migration, /cs\.client_organization_id IN \(v_job\.organization_id, COALESCE\(v_client_org, v_job\.organization_id\)\)/);
  assert.match(migration, /Harmed-party site must belong to the job''s client or custodian organisation/);
  assert.match(migration, /ELSIF v_address IS NOT NULL AND p_harmed_party_lat IS NOT NULL AND p_harmed_party_lng IS NOT NULL THEN/);
  assert.match(migration, /RETURNS TABLE\(out_dispatch_job_id uuid, out_harmed_party_site_id uuid, protected_party_recorded boolean, place_created boolean, house_action text\)/);
  // Identity still goes only to the protected table; audit never carries identity values.
  assert.match(migration, /INSERT INTO public\.dispatch_job_protected_parties/);
  const audit = migration.slice(migration.indexOf("'dispatch_job_harmed_party_set'"), migration.indexOf("'dispatch_job_harmed_party_set'") + 400);
  assert.doesNotMatch(audit, /p_display_name|p_phone|p_email|p_notes/);
});

test('intake keeps its signature and return shape while moving onto the seam', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.create_dispatch_intake_job\(\s+p_organization_id uuid, p_service_agreement_id uuid, p_client_request_id uuid, p_job_type text, p_priority text, p_sla_minutes integer,\s+p_location_name text, p_location_address text, p_location_lat double precision, p_location_lng double precision,\s+p_dispatch_resource_id uuid DEFAULT NULL, p_briefing_notes text DEFAULT NULL, p_shift_id uuid DEFAULT NULL\s+\) RETURNS TABLE\(id uuid, client_site_id uuid, created boolean, status text, sla_respond_by timestamp with time zone\)/);
  assert.match(migration, /INSERT INTO public\.service_agreement_locations \(service_agreement_id, site_id, status, created_by\)\s+VALUES \(p_service_agreement_id, v_place\.site_id, 'active', auth\.uid\(\)\) ON CONFLICT \(service_agreement_id, site_id\) DO NOTHING;/);
  assert.match(migration, /public\.create_dispatch_job\(p_organization_id, p_service_agreement_id, v_place\.site_id, p_client_request_id, p_job_type, p_priority, p_sla_minutes, p_dispatch_resource_id, p_briefing_notes, p_shift_id\)/);
  assert.doesNotMatch(migration, /DROP FUNCTION IF EXISTS public\.create_dispatch_intake_job/);
});

test('the disposable-database truth table exercises every rule the seam claims', () => {
  for (const label of [
    'address-only complainant place becomes a site on the job',
    'the complainant site is a provisional adhoc facet of the client org with a house',
    'the house belongs to the client org with the same key',
    'the centre is the resolved coordinate',
    'the same address resolves to the same site (no fork)',
    'one house per address per owner',
    'arrival at a provisional complainant place is unverified_boundary with a distance',
    'a stranger-org site cannot be the harmed-party place',
    'a house under another org is neither reused nor forked: facet flagged needs_review',
    'no second house was created for the conflicted address',
    'an unresolved address stays text-only (no site invented)',
    'intake creates the work place as a provisional site with a house, attached to the agreement',
    'every created place and house is audited',
  ]) {
    assert.ok(oracle.includes(label), `oracle must carry check: ${label}`);
  }
});
