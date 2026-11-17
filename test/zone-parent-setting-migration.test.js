'use strict';
// set_location_zone_parent gives location_zones.parent_zone_id a governed editor. The relation stays
// reporting-only (LOCATION_HOUSE_MODEL.md, ruling correction 2026-09-23); containment is advisory. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const migrationPath = path.join(root, 'supabase/migrations/20261117010000_zone_parent_setting.sql');
const migration = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n') : '';
const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
const definition = name => {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  assert.ok(start >= 0, name);
  return schema.slice(start, schema.indexOf('$function$;', start) + 11);
};
const table = name => {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${name}" (`);
  assert.ok(start >= 0, name);
  return `${schema.slice(start, schema.indexOf('\n);', start) + 3)}
    ALTER TABLE public.${name} ADD PRIMARY KEY(id);`;
};
const literal = value => value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const square = (west, south, east, north) =>
  `ST_GeomFromText('MULTIPOLYGON(((${west} ${south},${east} ${south},${east} ${north},${west} ${north},${west} ${south})))',4326)`;

test('the migration adds a governed, reporting-only parent editor and exposes the parent on the place map read', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.set_location_zone_parent\(p_zone_id uuid, p_parent_zone_id uuid, p_expected_version integer DEFAULT NULL\)/);
  assert.match(migration, /SECURITY DEFINER\s+SET search_path = public, pg_temp/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.set_location_zone_parent\(uuid, uuid, integer\) FROM PUBLIC, anon;/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.set_location_zone_parent\(uuid, uuid, integer\) TO authenticated, service_role;/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.get_crm_operational_geography\(\)/);
  assert.match(migration, /zone\.parent_zone_id/);
  // Every zone on the place editor carries its parent, not only those the geography read covers.
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.get_crm_operational_place_editor\(p_location_id uuid\)/);
  assert.match(migration, /'parent_zone_id',z\.parent_zone_id/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.get_crm_operational_place_editor\(uuid\) TO authenticated, service_role;/);
  // The zone can be deleted between the authorisation read and the locked re-read.
  assert.match(migration, /WHERE id = p_zone_id FOR UPDATE;\s+IF NOT FOUND THEN\s+RAISE EXCEPTION 'Zone not found';/);
  assert.doesNotMatch(migration, /FUNCTION public\.resolve_/);
  assert.doesNotMatch(migration, /\bDROP\b/i);
});

test('work-area parent setting, against disposable PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async () => {
  const name = `fcm-zone-parent-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
  });
  const sql = query => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1',
    '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], query).trim();
  const as = (actor, query) => sql(`BEGIN; SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claim.sub=${literal(actor)}; SELECT ${query}; COMMIT;`);
  const json = (actor, query) => JSON.parse(as(actor, query));
  const fails = (actor, query, expected) => assert.throws(() => as(actor, query), error => {
    const message = String(error.stderr ?? error.message);
    assert.ok(message.includes(`ERROR:  ${expected}`), `expected "${expected}", got: ${message}`);
    return true;
  });
  const setParent = (zone, parent, version) =>
    `public.set_location_zone_parent(${literal(zone)}, ${literal(parent)}, ${version == null ? 'NULL' : version})`;
  const version = zone => Number(sql(`SELECT configuration_version FROM public.location_zones WHERE id='${zone}'`));

  const admin = id(1); const officer = id(2); const otherAdmin = id(3);
  const org = id(10); const otherOrg = id(11);
  const house = id(20); const otherHouse = id(21); const otherOrgHouse = id(22);
  const estate = id(30); const block = id(31); const subBlock = id(32); const sibling = id(33);
  const point = id(34); const elsewhere = id(35); const foreign = id(36);
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try { sql('SELECT 1'); break; } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }

    sql(`
      CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO authenticated, anon;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY, organization_id uuid, role text, deactivated_at timestamptz);
      CREATE TABLE public.locations(id uuid PRIMARY KEY, organization_id uuid, canonical_place_id uuid, name text,
        address text, suburb text, postcode text, notes text);
      CREATE TABLE public.client_sites(id uuid PRIMARY KEY, client_organization_id uuid, location_id uuid, name text,
        address text, site_type text, active boolean, gps_lat double precision, gps_lng double precision,
        boundary geometry, boundary_status text, boundary_verification text, configuration_version integer);
      CREATE TABLE public.service_agreements(id uuid PRIMARY KEY, provider_organization_id uuid, client_organization_id uuid,
        starts_on date, ends_on date, agreement_type text);
      CREATE TABLE public.service_agreement_locations(id uuid PRIMARY KEY, service_agreement_id uuid, status text, site_id uuid, zone_id uuid);
      CREATE TABLE public.audit_log(id bigserial PRIMARY KEY, organization_id uuid, actor_user_id uuid, action text,
        target_table text, target_id uuid, metadata jsonb);
      ${table('location_zones')}
      ${table('patrol_checkpoints')}
      CREATE FUNCTION public.is_admin_for_org(target_org_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $fn$
        SELECT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND organization_id = target_org_id
          AND role = 'admin' AND deactivated_at IS NULL) $fn$;
      CREATE FUNCTION public.crm_actor_can_manage_location(p_location_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $fn$
        SELECT EXISTS (SELECT 1 FROM public.locations l JOIN public.user_profiles a ON a.id = auth.uid()
          WHERE l.id = p_location_id AND l.organization_id = a.organization_id) $fn$;
      ALTER TABLE public.client_sites ADD COLUMN risk_level text, ADD COLUMN site_brief text,
        ADD COLUMN access_instructions text, ADD COLUMN hs_notes text;
      CREATE TABLE public.module_catalog(module_key text PRIMARY KEY, active boolean);
      CREATE TABLE public.zone_closures(id uuid PRIMARY KEY, zone_id uuid, closure_type text, status text,
        effective_from timestamptz, effective_to timestamptz, reason text, resolution_notes text, created_at timestamptz DEFAULT now());
      CREATE FUNCTION public.get_descendant_organizations(uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $fn$ SELECT '{}'::uuid[] $fn$;
      ${definition('trg_location_zones_parent_same_org')}
      ${definition('guard_field_verification_point')}
      CREATE TRIGGER aa_field_verification_point BEFORE UPDATE ON public.location_zones
        FOR EACH ROW EXECUTE FUNCTION public.guard_field_verification_point();
      CREATE TRIGGER zz_location_zones_parent_same_org BEFORE INSERT OR UPDATE OF parent_zone_id ON public.location_zones
        FOR EACH ROW EXECUTE FUNCTION public.trg_location_zones_parent_same_org();

      INSERT INTO public.user_profiles VALUES
        ('${admin}','${org}','admin',NULL), ('${officer}','${org}','officer',NULL), ('${otherAdmin}','${otherOrg}','admin',NULL);
      INSERT INTO public.locations(id, organization_id, name) VALUES
        ('${house}','${org}','Synthetic estate'), ('${otherHouse}','${org}','Synthetic depot'),
        ('${otherOrgHouse}','${otherOrg}','Other operator place');
      INSERT INTO public.location_zones(id, organization_id, location_id, name, zone_type, module_key, boundary, is_verification_point, metadata) VALUES
        ('${estate}','${org}','${house}','Outer estate','general','patrol',${square(173.000, -41.300, 173.010, -41.290)},false,'{}'),
        ('${block}','${org}','${house}','Eastern block','general','patrol',${square(173.005, -41.300, 173.015, -41.290)},false,'{}'),
        ('${subBlock}','${org}','${house}','Eastern sub-block','general','patrol',${square(173.006, -41.299, 173.008, -41.297)},false,'{}'),
        ('${sibling}','${org}','${house}','Western block','general','patrol',${square(173.000, -41.300, 173.004, -41.296)},false,'{}'),
        ('${elsewhere}','${org}','${otherHouse}','Depot yard','general','patrol',${square(172.000, -41.300, 172.001, -41.299)},false,'{}'),
        ('${foreign}','${otherOrg}','${otherOrgHouse}','Other operator area','general','patrol',${square(173.000, -41.300, 173.010, -41.290)},false,'{}');
      INSERT INTO public.location_zones(id, organization_id, location_id, name, zone_type, module_key, center_point, is_verification_point, metadata) VALUES
        ('${point}','${org}','${house}','Gate verification point','general','patrol',ST_SetSRID(ST_MakePoint(173.001,-41.295),4326),true,'{"field_capture":{}}');
      INSERT INTO public.patrol_checkpoints(id, organization_id, location_id, zone_id, name, gps_lat, gps_lng, active) VALUES
        ('${id(40)}','${org}','${house}','${block}','Boat ramp',-41.295,173.012,true),
        ('${id(41)}','${org}','${house}','${block}','Inside track',-41.295,173.006,true),
        ('${id(42)}','${org}','${house}','${block}','Retired post',-41.295,173.013,false),
        ('${id(43)}','${otherOrg}','${house}','${block}','Another provider post',-41.295,173.014,true);
    `);
    sql(migration);

    // Grants
    assert.equal(sql(`SELECT has_function_privilege('anon','public.set_location_zone_parent(uuid,uuid,integer)','EXECUTE')`), 'f');
    assert.equal(sql(`SELECT has_function_privilege('authenticated','public.set_location_zone_parent(uuid,uuid,integer)','EXECUTE')`), 't');
    assert.equal(sql(`SELECT has_function_privilege('service_role','public.set_location_zone_parent(uuid,uuid,integer)','EXECUTE')`), 't');

    // Admin sets a partly-outside child; containment is advisory and measured on the ground.
    const set = json(admin, setParent(block, estate, 1));
    assert.equal(set.zone_id, block);
    assert.equal(set.parent_zone_id, estate);
    assert.equal(set.configuration_version, 2);
    assert.equal(set.changed, true);
    assert.equal(set.containment.status, 'measured');
    assert.ok(set.containment.inside_parent_percent > 49 && set.containment.inside_parent_percent < 51, JSON.stringify(set.containment));
    assert.ok(set.containment.outside_parent_hectares > 44 && set.containment.outside_parent_hectares < 48, JSON.stringify(set.containment));
    assert.equal(set.containment.checkpoints_outside.length, 1, JSON.stringify(set.containment));
    assert.equal(set.containment.checkpoints_outside[0].id, id(40));
    assert.equal(set.containment.checkpoints_outside[0].name, 'Boat ramp');
    const distance = set.containment.checkpoints_outside[0].distance_m;
    assert.ok(distance > 160 && distance < 175, `distance ${distance}`);
    assert.equal(sql(`SELECT parent_zone_id FROM public.location_zones WHERE id='${block}'`), estate);
    assert.equal(version(block), 2);
    const audit = JSON.parse(sql(`SELECT to_jsonb(a) FROM public.audit_log a WHERE target_id='${block}' ORDER BY id DESC LIMIT 1`));
    assert.equal(audit.action, 'crm_zone_parent_set');
    assert.equal(audit.organization_id, org);
    assert.equal(audit.actor_user_id, admin);
    assert.equal(audit.target_table, 'location_zones');
    assert.equal(audit.metadata.old_parent_zone_id, null);
    assert.equal(audit.metadata.new_parent_zone_id, estate);
    assert.equal(audit.metadata.configuration_version, 2);
    assert.equal(audit.metadata.location_id, house);

    // The place map read carries the parent and the advisory containment.
    const geography = json(admin, 'public.get_crm_operational_geography()');
    const mapped = geography.zones.find(zone => zone.id === block);
    assert.equal(mapped.parent_zone_id, estate);
    assert.ok(mapped.parent_containment.outside_parent_hectares > 44, JSON.stringify(mapped.parent_containment));
    assert.equal(geography.zones.find(zone => zone.id === estate).parent_zone_id, null);
    assert.equal(geography.zones.find(zone => zone.id === estate).parent_containment, null);
    const editor = json(admin, `public.get_crm_operational_place_editor(${literal(house)})`);
    assert.equal(editor.zones.find(zone => zone.id === block).parent_zone_id, estate);
    assert.equal(editor.zones.find(zone => zone.id === estate).parent_zone_id, null);
    assert.equal(editor.zones.some(zone => zone.id === point), false);
    assert.equal(sql(`SELECT has_function_privilege('anon','public.get_crm_operational_place_editor(uuid)','EXECUTE')`), 'f');

    // Stale optimistic version is refused and changes nothing.
    fails(admin, setParent(block, null, 1), 'Zone configuration changed since it was opened');
    assert.equal(sql(`SELECT parent_zone_id FROM public.location_zones WHERE id='${block}'`), estate);

    // Non-admins and administrators of another organisation are refused.
    fails(officer, setParent(sibling, estate, null), 'Active CRM administrator required for this location');
    fails(otherAdmin, setParent(sibling, estate, null), 'Active CRM administrator required for this location');
    fails(otherAdmin, setParent(id(99), estate, null), 'Active CRM administrator required for this location');
    assert.equal(sql(`SELECT parent_zone_id IS NULL FROM public.location_zones WHERE id='${sibling}'`), 't');

    // Invalid parents.
    fails(admin, setParent(sibling, foreign, null), 'Parent work area must belong to the same organisation');
    fails(admin, setParent(sibling, id(98), null), 'Parent work area must belong to the same organisation');
    fails(admin, setParent(sibling, elsewhere, null), 'Parent work area must be on the same place');
    fails(admin, setParent(sibling, sibling, null), 'A work area cannot be part of itself');
    fails(admin, setParent(sibling, point, null), 'A verification point cannot be a parent work area');
    fails(admin, setParent(point, estate, null), 'Verification points are not work areas');

    // Cycles, direct and through a grandchild.
    json(admin, setParent(subBlock, block, null));
    fails(admin, setParent(estate, block, null), 'A work area cannot be part of one of its own parts');
    fails(admin, setParent(estate, subBlock, null), 'A work area cannot be part of one of its own parts');
    assert.equal(sql(`SELECT parent_zone_id IS NULL FROM public.location_zones WHERE id='${estate}'`), 't');

    // A repeated identical request is a no-op: no version bump and no extra audit.
    const auditCount = () => Number(sql(`SELECT count(*) FROM public.audit_log WHERE action='crm_zone_parent_set'`));
    const before = auditCount();
    const same = json(admin, setParent(block, estate, 2));
    assert.equal(same.changed, false);
    assert.equal(same.configuration_version, 2);
    assert.equal(auditCount(), before);

    // Clearing the parent.
    const cleared = json(admin, setParent(block, null, 2));
    assert.equal(cleared.parent_zone_id, null);
    assert.equal(cleared.configuration_version, 3);
    assert.equal(cleared.containment.status, 'no_parent');
    assert.equal(sql(`SELECT parent_zone_id IS NULL FROM public.location_zones WHERE id='${block}'`), 't');
    const clearAudit = JSON.parse(sql(`SELECT metadata FROM public.audit_log WHERE target_id='${block}' ORDER BY id DESC LIMIT 1`));
    assert.equal(clearAudit.old_parent_zone_id, estate);
    assert.equal(clearAudit.new_parent_zone_id, null);
  } finally {
    if (created) docker(['rm', '--force', name]);
  }
});
