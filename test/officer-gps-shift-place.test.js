const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261107160000_officer_gps_shift_place.sql'), 'utf8');
const fn = (name) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.ok(start >= 0, `${name} is redefined`);
  const end = sql.indexOf('$function$;', start);
  return sql.slice(start, end);
};

test('live positions place a current shift on its contracted site', () => {
  const body = fn('get_live_officer_positions');
  assert.match(body, /s\.service_agreement_location_id\s+FROM public\.shifts s/);
  assert.match(body, /JOIN public\.service_agreement_locations sal ON sal\.id = os\.service_agreement_location_id/);
  assert.match(body, /JOIN public\.client_sites cs ON cs\.id = sal\.site_id/);
  assert.match(body, /ST_Covers\(cs\.boundary,/);
  assert.match(body, /coalesce\(cs\.onsite_radius_meters, 10\)/);
  assert.match(body, /'site', CASE WHEN ss\.site_id IS NULL THEN NULL ELSE jsonb_build_object\('id', ss\.site_id, 'name', ss\.site_name, 'on_site', ss\.on_site, 'distance_m', ss\.distance_m\)/);
  // Authorisation is untouched.
  assert.match(body, /is_admin_for_org\(p_organization_id\) OR public\.user_can_operate_organization\(p_organization_id\)/);
});

test('breadcrumbs prefer the shift assigned zone and never lose a position', () => {
  const body = fn('record_officer_breadcrumb');
  assert.match(body, /coalesce\(v_shift\.zone_id,\s*\(SELECT sal\.zone_id FROM public\.service_agreement_locations sal WHERE sal\.id = v_shift\.service_agreement_location_id\)\)/);
  assert.match(body, /z\.boundary_verification = 'verified'/);
  assert.match(body, /ELSE\s+SELECT r\.matched_zone_id INTO v_zone_id FROM public\.resolve_context/);
  assert.match(body, /EXCEPTION WHEN OTHERS THEN v_zone_id := NULL;/);
  assert.match(body, /RAISE EXCEPTION 'Shift does not belong to the authenticated officer'/);
});

test('resolver never names an inactive or archived organisation', () => {
  const body = fn('resolve_context');
  const guards = body.match(/o\.active AND o\.status IS DISTINCT FROM 'archived'/g) || [];
  assert.equal(guards.length, 3, 'district and both governor lookups are guarded');
});

test('grants stay server-side and authenticated only', () => {
  for (const sig of ['public.record_officer_breadcrumb(', 'public.get_live_officer_positions(']) {
    assert.ok(sql.includes(`REVOKE ALL ON FUNCTION ${sig}`), `${sig} revokes PUBLIC/anon`);
  }
  assert.doesNotMatch(sql, /TO anon/);
});
