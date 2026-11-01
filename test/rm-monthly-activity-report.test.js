const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.join(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'supabase', 'schema.sql'), 'utf8');
const migrationPath = path.join(root, 'supabase', 'migrations', '20261102210000_rm_monthly_activity_report.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');

const functionBody = (sql, header) => {
  const start = sql.indexOf(header);
  assert.ok(start >= 0, header);
  const open = sql.indexOf('$function$', start) + '$function$'.length;
  return sql.slice(open, sql.indexOf('$function$', open));
};
const builderBody = functionBody(migration, 'create or replace function public.build_agreement_activity_report(');
const accountingBody = functionBody(migration, 'create or replace function public.get_report_pack_activity_accounting(');
const generatorBody = functionBody(migration, 'create or replace function public.generate_due_report_packs(p_period_start date, p_period_end date, p_service_agreement_id uuid)');
const squash = text => text.replace(/\s+/g, ' ').trim();

test('generator keeps the live catalog body apart from activity and explicit NZ boundaries', () => {
  const catalog = functionBody(schema, 'CREATE OR REPLACE FUNCTION "public"."generate_due_report_packs"(p_period_start date, p_period_end date, p_service_agreement_id uuid)');
  if (catalog.includes('build_agreement_activity_report')) {
    assert.equal(squash(generatorBody), squash(catalog), 'catalog was refreshed after this migration');
    return;
  }
  const stripped = generatorBody
    .replace(/\n\tv_activity jsonb;/, '')
    .replace(/\n\t\tv_activity := public\.build_agreement_activity_report\([^\n]*\n/, '\n')
    .replace(/,\n\t\t\t'activityReport', v_activity -> 'report'/, '')
    .replace('data, activity_lines, generated_at', 'data, generated_at')
    .replace(/\n\t\t\tv_activity -> 'lines',/, '')
    .replace(/\n\t\t\tactivity_lines = excluded\.activity_lines,/, '')
    .replace("p_period_start::timestamp at time zone 'Pacific/Auckland'", 'p_period_start::timestamptz')
    .replace("(p_period_end + 1)::timestamp at time zone 'Pacific/Auckland'", "p_period_end::timestamptz + interval '1 day'");
  assert.equal(squash(stripped), squash(catalog));
  assert.match(generatorBody, /where existing\.status <> 'sent';/);
  assert.match(generatorBody, /get diagnostics v_written = row_count;\s+v_count := v_count \+ v_written;/);
});

test('only catalogue codes, parsed numbers, pattern-checked references and normalised narratives leave imported payloads', () => {
  const payloadKeys = new Set([...builderBody.matchAll(/(?:payload|imported) ->>? '([a-z_]+)'/g)].map(m => m[1]));
  assert.deepEqual([...payloadKeys].sort(), [
    'action_notes', 'biosecurity_species_code', 'comments', 'equipment_type_code', 'issue', 'job_number',
    'material_type_code', 'materials_used', 'source_category', 'work_activity_code', 'work_subject_code',
  ]);
  const materialKeys = new Set([...builderBody.matchAll(/\bm (?:->>|\?) '([a-z_]+)'/g)].map(m => m[1]));
  assert.deepEqual([...materialKeys].sort(), ['calibre', 'material_type', 'quantity']);
  for (const key of ['comments', 'issue', 'action_notes']) {
    const reads = [...builderBody.matchAll(new RegExp(`->> '${key}'`, 'g'))].length;
    const normalised = [...builderBody.matchAll(new RegExp(`report_text_or_null\\([a-z]\\.(?:payload|imported) ->> '${key}'`, 'g'))].length;
    assert.ok(reads > 0 && reads === normalised, `${key} is always normalised`);
  }
  for (const column of ['officer_notes', 'title', 'description', 'completion_note']) {
    assert.match(builderBody, new RegExp(`report_text_or_null\\([a-z]\\.${column}, `), `${column} is normalised`);
  }
  for (const forbidden of ['patroller', 'reg_raw', 'location_raw', 'reserve_raw', 'action_by', 'closed_by', '_cost', 'charge_', 'unit_price', 'source_file', 'plate', 'gps', 'display_name', 'resolution_notes', '\\.summary\\b', 'legal_hold']) {
    assert.doesNotMatch(builderBody, new RegExp(forbidden), `builder must not read ${forbidden}`);
  }
  assert.deepEqual([...new Set([...builderBody.matchAll(/\binv\.([a-z_]+)/g)].map(m => m[1]))].sort(),
    ['id', 'investigation_reference', 'organization_id', 'status'], 'only the investigation reference and status reach the report');
  assert.match(builderBody, /and not i\.is_staff_sensitive/, 'staff-sensitive incidents never reach a client report');
  assert.match(builderBody, /where e\.source is distinct from 'observation_trigger'/, 'observation mirror events are not counted twice');
  assert.doesNotMatch(builderBody, /distance_km|job_time_hours/, 'travel distance and job hours are operational, not client report content');
  assert.match(builderBody, /'reconciled', \(/);
  assert.match(builderBody, /at time zone 'Pacific\/Auckland'/);
});

test('internal assemblers are postgres-only and the accounting check is provider-only', () => {
  for (const signature of [
    'report_numeric_or_null(text)', 'report_code_or_null(text)', 'report_service_line(text)', 'report_text_or_null(text, integer)',
    'report_activity_category(text, text, text, text, text, text, text, text)',
    'build_agreement_activity_report(uuid, timestamptz, timestamptz, integer)',
  ]) {
    const escaped = signature.replace(/[()]/g, '\\$&');
    assert.match(migration, new RegExp(`revoke all on function public\\.${escaped} from public, anon, authenticated, service_role;\\ngrant execute on function public\\.${escaped} to postgres;\\n`));
    assert.doesNotMatch(migration, new RegExp(`grant execute on function public\\.${escaped} to (anon|authenticated|service_role)`));
  }
  assert.match(migration, /revoke all on function public\.get_report_pack_activity_accounting\(uuid\) from public, anon, authenticated, service_role;/);
  assert.match(migration, /grant execute on function public\.get_report_pack_activity_accounting\(uuid\) to authenticated;/);
  assert.doesNotMatch(migration, /grant execute on function public\.get_report_pack_activity_accounting\(uuid\) to anon/);
  assert.match(accountingBody, /if not public\.is_report_provider_custodian_for_org\(v_pack\.organization_id\) then\s+raise exception 'Provider administrator access required';/);
  assert.doesNotMatch(accountingBody, /\b(insert|update|delete)\b\s+(into\s+)?public\./i, 'accounting is read-only');
  assert.match(migration, /add column if not exists activity_lines jsonb/);
});

const fixtureTables = ['organizations', 'user_profiles', 'service_agreements', 'service_agreement_locations', 'client_sites',
  'location_zones', 'location_events', 'location_events_superseded', 'observations', 'observation_supporting_evidence',
  'evidence_items', 'workshop_work_orders', 'reference_codes', 'patrol_import_record_versions', 'file_import_batches',
  'monthly_report_packs', 'audit_log', 'sla_clocks', 'incidents', 'incident_attachments', 'investigations',
  'patrol_checkpoint_visits', 'breach_alerts'];
const tableDDL = name => {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${name}" (`);
  assert.ok(start >= 0, name);
  return schema.slice(start, schema.indexOf('\n);', start) + 3);
};
const catalogFunction = name => {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  assert.ok(start >= 0, name);
  return schema.slice(start, schema.indexOf('$function$;', start) + 11);
};
const constraints = () => [...schema.matchAll(/ALTER TABLE ONLY "public"\."([^"]+)"\s+ADD CONSTRAINT[\s\S]*?;/g)]
  .filter(([sql, name]) => fixtureTables.includes(name)
    && (!sql.includes('FOREIGN KEY') || fixtureTables.includes(sql.match(/REFERENCES "public"\."([^"]+)"/)?.[1])))
  .map(([sql]) => sql).join('\n');

test('real PostgreSQL builds a reconciled client site activity report', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 120000,
}, async () => {
  const name = `fcm-rm-activity-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  const id = n => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const provider = id(1), client = id(2), otherProvider = id(3);
  const admin = id(10), officer = id(11), outsider = id(12);
  const agreement = id(20), otherAgreement = id(21);
  const alpha = id(30), beta = id(31), gamma = id(32), depot = id(33);
  const batch = id(40);
  const ev = n => id(100 + n), ob = n => id(200 + n), wo = n => id(300 + n);
  const nz = local => `timestamptz '${local} Pacific/Auckland'`;
  const actor = who => `RESET ROLE; SELECT set_config('request.jwt.claim.sub','${who}',false); SET ROLE authenticated;`;
  const report = `(SELECT data->'activityReport' FROM public.monthly_report_packs WHERE service_agreement_id='${agreement}')`;
  const lines = `(SELECT activity_lines FROM public.monthly_report_packs WHERE service_agreement_id='${agreement}')`;
  const pack = `(SELECT id FROM public.monthly_report_packs WHERE service_agreement_id='${agreement}')`;
  const event = (n, zone, site, at, type, payload, km = 'null', source = 'rm_patrol_log_import') =>
    `('${ev(n)}','${client}',${zone ? `'${zone}'` : 'null'},${site ? `'${site}'` : 'null'},'${type}','patrol',${at},'${source}','${JSON.stringify(payload)}'::jsonb,${km})`;
  const inc = n => id(400 + n);
  const canaries = {
    comments: 'Two possums culled near the north gate', issue: 'Cull', action_notes: 'Bait station\n   refilled',
    patroller_raw: 'CANARY_OFFICER', action_by: 'CANARY_ACTION_BY', closed_by: 'CANARY_CLOSED_BY', reg_raw: 'CANARYPLATE',
    job_cost: '999.99', subject: 'CANARY_SUBJECT',
  };
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none', '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'PostgreSQL test database ready');
    const setup = `
      SET TimeZone = 'UTC';
      CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO PUBLIC;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $f$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $f$;
      ${fixtureTables.map(tableDDL).join('\n')}
      ${constraints()}
      ${['get_descendant_organizations', 'is_admin_for_org', 'report_provider_custodian_for_actor', 'is_report_provider_custodian_for_org'].map(catalogFunction).join('\n')}
      CREATE FUNCTION public.agreement_service_delivery(p_agreement_id uuid, p_period_start date, p_period_end date)
        RETURNS jsonb LANGUAGE sql STABLE AS $f$ SELECT '{"places":[]}'::jsonb $f$;
      ${migration}
      CREATE FUNCTION public.assert_ok(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $f$
        BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed: %', label; END IF; END $f$;
      CREATE FUNCTION public.expect_error(statement text, expected text) RETURNS void LANGUAGE plpgsql AS $f$
        DECLARE failed boolean := false;
        BEGIN
          BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN
            IF position(expected IN SQLERRM)=0 THEN RAISE EXCEPTION 'Unexpected error: %; expected %', SQLERRM, expected; END IF;
            failed := true;
          END;
          IF NOT failed THEN RAISE EXCEPTION 'Expected error: %', expected; END IF;
        END $f$;
      GRANT EXECUTE ON FUNCTION public.assert_ok(boolean,text), public.expect_error(text,text) TO PUBLIC;

      INSERT INTO public.organizations(id,name,organization_type) VALUES
        ('${provider}','Fixture provider','service_provider'),('${client}','Fixture client','client'),
        ('${otherProvider}','Other provider','service_provider');
      INSERT INTO public.user_profiles(id,organization_id,employer_organization_id,role,display_name) VALUES
        ('${admin}','${provider}','${provider}','admin','Test administrator'),
        ('${officer}','${provider}','${provider}','officer','Test officer'),
        ('${outsider}','${otherProvider}','${otherProvider}','admin','Other administrator');
      INSERT INTO public.service_agreements(id,provider_organization_id,client_organization_id,name,agreement_type,monthly_report_template_code) VALUES
        ('${agreement}','${provider}','${client}','Reserves R&M','operational','rm_monthly'),
        ('${otherAgreement}','${provider}','${client}','Parks','operational',null);
      INSERT INTO public.location_zones(id,organization_id,name,location_id) VALUES
        ('${alpha}','${client}','Alpha Reserve','${id(50)}'),('${beta}','${client}','Beta Park','${id(51)}'),
        ('${gamma}','${client}','Gamma Unlinked','${id(52)}');
      INSERT INTO public.client_sites(id,client_organization_id,name,location_id,center_point) VALUES
        ('${depot}','${client}','Delta Depot','${id(53)}',ST_SetSRID(ST_Point(173.28,-41.27),4326));
      INSERT INTO public.service_agreement_locations(service_agreement_id,zone_id,site_id,status) VALUES
        ('${agreement}','${alpha}',null,'active'),('${agreement}',null,'${depot}','active'),
        ('${otherAgreement}','${beta}',null,'active');
      INSERT INTO public.reference_codes(organization_id,code_type,code,name) VALUES
        ('${provider}','work_activity','cull','Cull (provider)'),('${client}','work_activity','cull','Cull (client copy)'),
        ('${client}','biosecurity_species','goat','CANARY_FOREIGN_LABEL'),
        ('${provider}','biosecurity_species','possum','Possum'),('${provider}','work_subject','gate','Gate');
      INSERT INTO public.reference_codes(id,organization_id,code_type,code,name) VALUES
        ('${id(70)}','${provider}','work_activity','maintenance','Repair'),
        ('${id(71)}','${provider}','work_activity','inspection','Inspect'),
        ('${id(72)}','${otherProvider}','work_subject','private_item','CANARY_FOREIGN_SUBJECT'),
        ('${id(73)}','${otherProvider}','work_activity','private_action','CANARY_FOREIGN_ACTIVITY');

      INSERT INTO public.location_events(id,organization_id,zone_id,client_site_id,event_type,module_key,occurred_at,source,payload,distance_km) VALUES
        ${event(1, alpha, null, nz('2026-10-01 00:30'), 'patrol_visit', { ...canaries, work_subject_code: 'animal', work_activity_code: 'cull', biosecurity_species_code: 'possum', material_type_code: 'ammunition', materials_used: [{ material_type: 'ammunition', calibre: '.22', quantity: 3, unit_price: 1.5 }], job_number: 'J-1001', job_time_hours: '1.5', source_category: 'PEST CONTROL' }, '12.5')},
        ${event(2, alpha, null, nz('2026-10-02 09:00'), 'patrol_visit', { work_subject_code: 'animal', work_activity_code: 'sighting', biosecurity_species_code: 'goat' })},
        ${event(3, alpha, null, nz('2026-10-03 09:00'), 'patrol_visit', { work_subject_code: 'pest_device', work_activity_code: 'rebait', equipment_type_code: 'bait_station', material_type_code: 'bait_feed', materials_used: [{ material_type: 'bait_feed', item: 'CANARY_ITEM bags', quantity: 2 }] })},
        ${event(4, null, depot, nz('2026-10-04 09:00'), 'patrol_visit', { work_subject_code: 'gate', work_activity_code: 'maintenance', job_time_hours: '2', job_number: 'Call CANARY on 021' })},
        ${event(5, alpha, null, nz('2026-10-05 09:00'), 'patrol_visit', { work_subject_code: 'gate', work_activity_code: 'manufacture', job_time_hours: 'two hours' }, '4')},
        ${event(6, alpha, null, nz('2026-10-06 09:00'), 'patrol_visit', { work_subject_code: 'camera', work_activity_code: 'installation' })},
        ${event(7, alpha, null, nz('2026-10-07 09:00'), 'patrol_visit', { work_subject_code: 'other', work_activity_code: 'securing' })},
        ${event(8, alpha, null, nz('2026-10-08 09:00'), 'patrol_visit', {})},
        ${event(9, alpha, null, nz('2026-10-09 09:00'), 'camera_activation', {})},
        ${event(10, alpha, null, nz('2026-10-10 09:00'), 'patrol_log_unattributed', {})},
        ${event(11, alpha, null, nz('2026-10-11 09:00'), 'observation', { plate: 'CANARYPLATE' }, 'null', 'observation_trigger')},
        ${event(12, beta, null, nz('2026-10-12 09:00'), 'patrol_visit', { work_activity_code: 'cull' })},
        ${event(13, gamma, null, nz('2026-10-13 09:00'), 'patrol_visit', { work_activity_code: 'cull' })},
        ${event(14, alpha, null, nz('2026-11-01 00:30'), 'patrol_visit', { work_activity_code: 'cull' })},
        ${event(15, alpha, null, nz('2026-10-15 09:00'), 'patrol_visit', { work_activity_code: 'CANARY drop table' })},
        ${event(16, alpha, null, nz('2926-08-23 09:00'), 'patrol_visit', {})},
        ${event(17, alpha, null, nz('2016-10-15 09:00'), 'patrol_visit', {})},
        ${event(20, alpha, null, nz('2026-10-16 07:00'), 'patrol_visit', { comments: 'Start' })},
        ${event(21, alpha, null, nz('2026-10-16 07:05'), 'patrol_visit', { work_activity_code: 'travel', work_subject_code: 'general', comments: 'Travel to site' })},
        ${event(22, null, depot, nz('2026-10-16 07:10'), 'patrol_visit', { issue: 'Admin', comments: 'Timesheets' })},
        ${event(23, alpha, null, nz('2026-10-16 18:00'), 'patrol_visit', { comments: 'Exit.' })};
      INSERT INTO public.observations(id,organization_id,zone_id,site_id,module_key,observed_at,plate_number,photo_url,distance_km,external_refs) VALUES
        ('${ob(1)}','${client}','${alpha}',null,'patrol',${nz('2026-10-20 10:00')},'CANARYPLATE2','scans/one.jpg',3,
          '{"import":{"work_activity_code":"inspection","work_subject_code":"gate","job_number":"J-2002","issue":"Check","comments":"Campervan parked overnight at the boat ramp"}}'),
        ('${ob(2)}','${client}',null,'${depot}','freedom_camping',${nz('2026-10-21 10:00')},'CANARYPLATE3',null,null,'{}'),
        ('${ob(3)}','${client}','${gamma}',null,'patrol',${nz('2026-10-22 10:00')},'OUTSIDE1',null,null,'{}');
      INSERT INTO public.observation_supporting_evidence(organization_id,observation_id,evidence_kind,storage_bucket,storage_path,notes) VALUES
        ('${client}','${ob(1)}','external_photo','bob-uploads','p/1.jpg','CANARY_NOTE');
      INSERT INTO public.evidence_items(organization_id,module_key,evidence_kind,storage_path,metadata,location_event_id) VALUES
        ('${client}','patrol','photo','p/1.jpg',jsonb_build_object('observation_id','${ob(1)}'),null),
        ('${client}','patrol','photo','p/2.jpg',jsonb_build_object('observation_id','${ob(1)}'),null),
        ('${client}','patrol','photo','e/1.jpg','{}','${ev(1)}'),
        ('${client}','patrol','photo','scans/one.jpg',jsonb_build_object('observation_id','${ob(1)}'),null),
        ('${client}','patrol','photo','scans/one-original.jpg',jsonb_build_object('observation_id','${ob(1)}'),null),
        ('${client}','patrol','photo','e/9.jpg','{}','${ev(9)}'),
        ('${client}','patrol','photo','e/23.jpg','{}','${ev(23)}');
      INSERT INTO public.evidence_items(id,organization_id,module_key,evidence_kind,storage_path) VALUES
        ('${id(80)}','${client}','cctv','photo','i/1.jpg'),('${id(81)}','${client}','cctv','video','v/1.mp4'),
        ('${id(82)}','${client}','cctv','photo','i/staff.jpg');
      INSERT INTO public.investigations(id,organization_id,investigation_reference,title,summary,resolution_notes,status,created_by) VALUES
        ('${id(90)}','${provider}','INV-2026-0042','CANARY_INV_TITLE','CANARY_INV_SUMMARY','CANARY_INV_RESOLUTION','active','${admin}');
      INSERT INTO public.incidents(id,organization_id,zone_id,client_site_id,incident_type,severity,status,description,occurred_at,location_event_id,investigation_id,is_staff_sensitive) VALUES
        ('${inc(1)}','${client}','${alpha}',null,'cctv_bookmark','high','in_review',E'Vehicle entered after closing;\n CCTV reviewed',${nz('2026-10-16 21:00')},'${ev(9)}','${id(90)}',false),
        ('${inc(2)}','${provider}','${alpha}',null,'staff_injury','standard','open','CANARY_STAFF_SENSITIVE',${nz('2026-10-17 21:00')},null,null,true),
        ('${inc(3)}','${otherProvider}','${alpha}',null,'trespass','standard','open','CANARY_OTHER_ORG',${nz('2026-10-17 21:00')},null,null,false),
        ('${inc(4)}','${client}','${gamma}',null,'trespass','standard','open','CANARY_UNLINKED_PLACE',${nz('2026-10-17 21:00')},null,null,false);
      INSERT INTO public.incident_attachments(organization_id,incident_id,evidence_item_id,attachment_kind) VALUES
        ('${client}','${inc(1)}','${id(80)}','photo'),('${client}','${inc(1)}','${id(81)}','video'),
        ('${provider}','${inc(2)}','${id(82)}','photo');
      UPDATE public.observations SET watermarked_photo_url=photo_url, original_photo_url='scans/one-original.jpg' WHERE id='${ob(1)}';
      INSERT INTO public.workshop_work_orders(id,organization_id,client_request_id,order_number,kind,status,title,service_agreement_id,zone_id,asset_id,scheduled_for,completed_at) VALUES
        ('${wo(1)}','${provider}','${id(61)}','WO-1','maintenance','completed','Repair gate hinge','${agreement}',null,'${id(65)}',null,${nz('2026-10-15 12:00')}),
        ('${wo(2)}','${provider}','${id(62)}','WO-2','fabrication','in_progress','Gate build',null,'${alpha}',null,${nz('2026-10-20 12:00')},null),
        ('${wo(3)}','${provider}','${id(63)}','WO-3','maintenance','cancelled','Cancelled','${agreement}','${alpha}',null,${nz('2026-10-20 12:00')},null),
        ('${wo(4)}','${provider}','${id(64)}','WO-4','maintenance','draft','Draft','${agreement}','${alpha}',null,${nz('2026-10-20 12:00')},null),
        ('${wo(5)}','${otherProvider}','${id(66)}','PRIVATE-ORDER','maintenance','completed','Private order',null,'${alpha}',null,null,${nz('2026-10-20 12:00')}),
        ('${wo(6)}','${otherProvider}','${id(67)}','PRIVATE-LINK','fabrication','completed','Private order','${agreement}',null,null,null,${nz('2026-10-20 12:00')});
      UPDATE public.workshop_work_orders
        SET work_subject_code_id=(SELECT id FROM public.reference_codes WHERE organization_id='${provider}' AND code_type='work_subject' AND code='gate'),
            work_activity_code_id='${id(70)}', description='Hinge bent by vehicle', completion_note='Hinge replaced and gate rehung' WHERE id='${wo(1)}';
      INSERT INTO public.file_import_batches(id,organization_id,batch_name,source_file,parser,status,row_count,duplicate_count,unresolved_count,created_by) VALUES
        ('${batch}','${provider}','October log','RM Patrol Log Oct.xlsx','rm_patrol_log','applied',100,2,1,'${admin}');
      INSERT INTO public.patrol_import_record_versions(provider_organization_id,client_organization_id,record_kind,record_id,external_ref,source_profile,source_file,source_sheet,source_row,source_sha256,derivative_sha256,source_fingerprint,batch_id,version_no,change_kind,state_after,applied_by,is_current) VALUES
        ('${provider}','${client}','event','${ev(1)}','rm:1','rm','RM Patrol Log Oct.xlsx','Pest',2,repeat('a',64),repeat('b',64),repeat('c',64),'${batch}',1,'baseline','{}','${admin}',true),
        ('${provider}','${client}','event','${ev(2)}','rm:2','rm','RM Patrol Log Oct.xlsx','Pest',3,repeat('a',64),repeat('b',64),repeat('d',64),'${batch}',1,'baseline','{}','${admin}',true),
        ('${provider}','${client}','observation','${ob(1)}','rm:3','rm','RM Patrol Log Oct.xlsx','Vehicles',4,repeat('a',64),repeat('b',64),repeat('e',64),'${batch}',1,'baseline','{}','${admin}',true),
        ('${otherProvider}','${client}','event','${ev(3)}','private:1','rm','PRIVATE-PROVIDER.xlsx','Private',1,repeat('a',64),repeat('b',64),repeat('f',64),'${batch}',1,'baseline','{}','${outsider}',true),
        ('${provider}','${otherProvider}','event','${ev(4)}','private:2','rm','PRIVATE-CLIENT.xlsx','Private',1,repeat('a',64),repeat('b',64),repeat('f',64),'${batch}',1,'baseline','{}','${admin}',true);
      INSERT INTO public.location_events_superseded(provider_organization_id,client_organization_id,location_event_id,external_ref,canonical_location_event_id,canonical_external_ref,reason_code,batch_id,event_snapshot,superseded_by) VALUES
        ('${provider}','${client}','${id(99)}','rm:dup','${ev(1)}','rm:1','duplicate_of_canonical_sheet','${batch}',
          jsonb_build_object('occurred_at','2026-10-05T10:00:00+13:00','zone_id','${alpha}'),'${admin}');

      ${actor(officer)}
      SELECT public.expect_error($q$SELECT public.generate_due_report_packs('2026-10-01','2026-10-31','${agreement}')$q$,'Active provider administrator required');
      SELECT public.expect_error($q$SELECT public.build_agreement_activity_report('${agreement}',now(),now(),10)$q$,'permission denied');
      ${actor(admin)}
      SELECT public.assert_ok(public.generate_due_report_packs('2026-10-01','2026-10-31','${agreement}')=1,'one pack generated');
      RESET ROLE;

      SELECT public.assert_ok((${report}->'totals')=jsonb_build_object('entries',17,'events',12,'observations',2,'workOrders',2,'incidents',1,
        'patrolVisits',10,'cameraActivations',1,'withNotes',5,'places',2,'photos',7),'totals: '||(${report}->'totals')::text);
      SELECT public.assert_ok((SELECT (data->>'operationalEvents')::int=16 FROM public.monthly_report_packs WHERE service_agreement_id='${agreement}'),'existing metrics unchanged');
      SELECT public.assert_ok((SELECT jsonb_object_agg(c->>'code',(c->>'entries')::int) FROM jsonb_array_elements(${report}->'categories') c)=
        '{"incident":1,"pest_control":3,"maintenance":2,"manufacture":2,"installation_removal":1,"securing":1,"inspection":1,"camera_activation":1,"vehicle_observation":1,"patrol_visit":3,"unclassified":1}'::jsonb,
        'categories: '||(${report}->'categories')::text);
      SELECT public.assert_ok((SELECT array_agg(c->>'code' ORDER BY o) FROM jsonb_array_elements(${report}->'categories') WITH ORDINALITY x(c,o))
        =ARRAY['incident','pest_control','maintenance','manufacture','installation_removal','securing','inspection','camera_activation','vehicle_observation','patrol_visit','unclassified'],
        'categories follow the report order, incidents first');
      SELECT public.assert_ok((${report}->'accountedFor')=jsonb_build_object('eventsInScope',16,'mirrorEventsExcluded',1,'activityEvents',15,
        'observationsInScope',2,'workOrdersInScope',2,'incidentsInScope',1,'entries',20,'reported',17,'operationalWithheld',3,
        'withheldTravelAdmin',2,'withheldShiftMarkers',1,'itemised',17,'notItemised',0,'unclassified',1,'reconciled',true),
        'accounted for: '||(${report}->'accountedFor')::text);
      SELECT public.assert_ok(position('Start' IN ${lines}::text)=0 AND position('Travel to site' IN ${lines}::text)=0
        AND position('Timesheets' IN ${lines}::text)=0 AND NOT (${report}->'labels'->'category' ? 'travel_admin'),
        'travel, administration and shift markers are withheld from the client report');
      SELECT public.assert_ok((SELECT l->>'n'='Exit.' AND l->>'ph'='1' FROM jsonb_array_elements(${lines}->'lines') l WHERE l->>'t'='18:00'),
        'a photographed movement entry is still reported');
      SELECT public.assert_ok((${report}->'pestControl'->'bySpecies')='[{"code":"goat","culls":0,"sightings":1,"other":0,"total":1},{"code":"possum","culls":1,"sightings":0,"other":0,"total":1}]'::jsonb,'pest species: '||(${report}->'pestControl'->'bySpecies')::text);
      SELECT public.assert_ok((${report}->'pestControl'->'ammunition')='[{"calibre":".22","entries":1,"rounds":3}]'::jsonb,'ammunition');
      SELECT public.assert_ok((${report}->'pestControl'->'byEquipment')='[{"code":"bait_station","entries":1}]'::jsonb,'pest equipment');
      SELECT public.assert_ok((${report}->'maintenance'->'workOrders')='{"completed":1,"open":0}'::jsonb
        AND (${report}->'manufacture'->'workOrders')='{"completed":0,"open":1}'::jsonb
        AND (${report}->'maintenance'->>'entries')::int=2,'maintenance and manufacture');
      SELECT public.assert_ok((${report}->'observations')->>'withPhoto'='1' AND (${report}->'observations')->>'photos'='3','photos are counted once per stored file');
      SELECT public.assert_ok((SELECT l->>'ph'='3' AND l->'pr' @> '[{"b":"bob-uploads","p":"p/1.jpg"},{"b":"bob-uploads","p":"p/2.jpg"},{"b":"scans","p":"scans/one.jpg"}]'::jsonb
        AND jsonb_array_length(l->'pr')=3 AND l->>'ti'='Check' AND l->>'n'='Campervan parked overnight at the boat ramp' AND l->>'mo'='patrol'
        FROM jsonb_array_elements(${lines}->'lines') l WHERE l->>'j'='J-2002'),'observation line carries its narrative and one reference per stored photo');
      SELECT public.assert_ok((${report}->'incidents')='{"total":1,"investigations":1,"withMedia":1,"bySeverity":[{"code":"high","entries":1}],"byStatus":[{"code":"in_review","entries":1}]}'::jsonb,
        'incidents: '||(${report}->'incidents')::text);
      SELECT public.assert_ok((SELECT l - 'pr'=jsonb_build_object('d','2026-10-16','t','21:00','p','Alpha Reserve','k','incident','c','incident',
          'it','cctv_bookmark','sev','high','st','in_review','inv','INV-2026-0042','ivs','active','n','Vehicle entered after closing; CCTV reviewed','ph',2,'vid',1)
        AND l->'pr'='[{"b":"bob-uploads","p":"e/9.jpg"},{"b":"bob-uploads","p":"i/1.jpg"}]'::jsonb
        FROM jsonb_array_elements(${lines}->'lines') l WHERE l->>'k'='incident'),'incident line: '||(SELECT string_agg(l::text,',') FROM jsonb_array_elements(${lines}->'lines') l WHERE l->>'k'='incident'));
      SELECT public.assert_ok((SELECT count(*) FROM jsonb_array_elements(${lines}->'lines') l WHERE l->>'k'='incident')=1,
        'staff-sensitive, other-organisation and unlinked incidents are excluded');
      SELECT public.assert_ok((${report}->'labels'->'activity'->>'cull')='Cull (provider)' AND (${report}->'labels'->'species'->>'goat')='Goat'
        AND (${report}->'labels'->'category'->>'incident')='Incidents and investigations','provider catalogue labels with readable fallback');
      SELECT public.assert_ok((SELECT array_agg(p->>'place' ORDER BY p->>'place') FROM jsonb_array_elements(${report}->'byPlace') p)=ARRAY['Alpha Reserve','Delta Depot','Not location-specific'],'places');
      SELECT public.assert_ok(jsonb_array_length(${lines}->'lines')=17 AND (${lines}->>'notItemised')::int=0 AND (${lines}->>'version')::int=2,'all reported entries itemised');
      SELECT public.assert_ok((${lines}->'lines'->0)=jsonb_build_object('d','2026-10-01','t','00:30','p','Alpha Reserve','k','event','c','pest_control','a','cull',
        's','animal','sp','possum','j','J-1001','ph',1,'pr',jsonb_build_array(jsonb_build_object('b','bob-uploads','p','e/1.jpg')),
        'm',jsonb_build_array(jsonb_build_object('t','ammunition','cal','.22','q',3)),
        'ti','Cull','n','Two possums culled near the north gate','ac','Bait station refilled'),
        'first line: '||(${lines}->'lines'->0)::text);
      SELECT public.assert_ok((SELECT l->'m' FROM jsonb_array_elements(${lines}->'lines') l WHERE l->>'a'='rebait')='[{"t":"bait_feed","q":2}]'::jsonb,'materials keep type and count only');
      SELECT public.assert_ok((SELECT l->>'s'='gate' AND l->>'a'='maintenance' AND l->>'ti'='Repair gate hinge' AND l->>'n'='Hinge bent by vehicle'
        AND l->>'ac'='Hinge replaced and gate rehung' AND NOT (l ? 'p') FROM jsonb_array_elements(${lines}->'lines') l WHERE l->>'j'='WO-1'),'coded workshop subject, activity and narrative survive');
      SELECT public.assert_ok(position('PRIVATE-' IN ${lines}::text)=0,'another provider cannot contribute work orders even at a shared place or by agreement ID');
      SELECT public.assert_ok((SELECT count(*) FROM jsonb_array_elements(${lines}->'lines') l WHERE l ? 'j' AND l->>'k'='event' AND l->>'a'='maintenance')=0,'free-text job references are dropped');
      SELECT public.assert_ok((SELECT position('CANARY' IN data::text || activity_lines::text)=0 AND position('999.99' IN data::text || activity_lines::text)=0
        AND position('unit_price' IN activity_lines::text)=0 AND position('.xlsx' IN data::text || activity_lines::text)=0
        AND position('i/staff.jpg' IN activity_lines::text)=0
        FROM public.monthly_report_packs WHERE service_agreement_id='${agreement}'),'no names, plates, costs, file names, investigation detail or excluded incidents');
      SELECT public.assert_ok((SELECT NOT (data->'activityReport'->'totals' ? 'travelKm') AND NOT (data->'activityReport'->'totals' ? 'hours')
        AND position('"km"' IN activity_lines::text)=0 AND position('"h"' IN activity_lines::text)=0
        FROM public.monthly_report_packs WHERE service_agreement_id='${agreement}'),'no travel distance or job hours in the client report');

      SELECT public.assert_ok((SELECT (r->'lines'->>'notItemised')::int=12 AND jsonb_array_length(r->'lines'->'lines')=5
        AND (r->'report'->'accountedFor'->>'itemised')::int=5 AND (r->'report'->'accountedFor'->>'reconciled')::boolean
        AND r->'report'->>'itemisedDigest'=${report}->>'itemisedDigest'
        FROM public.build_agreement_activity_report('${agreement}',${nz('2026-10-01 00:00')},${nz('2026-11-01 00:00')},5) r),'line cap keeps exact totals and digest');

      SELECT set_config('request.jwt.claim.sub','',false);
      SELECT public.expect_error($q$SELECT public.get_report_pack_activity_accounting(${pack})$q$,'Authenticated provider administrator required');
      CREATE TEMP TABLE accounting(data jsonb);
      GRANT ALL ON accounting TO authenticated; GRANT SELECT ON public.monthly_report_packs TO authenticated;
      ${actor(outsider)}
      SELECT public.expect_error($q$SELECT public.get_report_pack_activity_accounting('${id(0)}')$q$,'Report pack not found');
      SELECT public.expect_error(format('SELECT public.get_report_pack_activity_accounting(%L)',(SELECT id FROM public.monthly_report_packs LIMIT 1)),'Provider administrator access required');
      RESET ROLE;
      UPDATE public.user_profiles SET role='grand_master' WHERE id='${outsider}';
      ${actor(outsider)}
      SELECT public.assert_ok(public.is_admin_for_org('${provider}'),'generic admin helper allows foreign grand master');
      SELECT public.expect_error(format('SELECT public.get_report_pack_activity_accounting(%L)',(SELECT id FROM public.monthly_report_packs LIMIT 1)),'Provider administrator access required');
      RESET ROLE;
      UPDATE public.user_profiles SET role='admin' WHERE id='${outsider}';
      INSERT INTO public.service_agreements(provider_organization_id,client_organization_id,name,agreement_type)
        VALUES ('${otherProvider}','${provider}','Outside service contract','operational');
      ${actor(outsider)}
      SELECT public.assert_ok(public.is_admin_for_org('${provider}'),'generic helper allows agreement-based administrator');
      SELECT public.expect_error(format('SELECT public.get_report_pack_activity_accounting(%L)',(SELECT id FROM public.monthly_report_packs LIMIT 1)),'Provider administrator access required');
      ${actor(officer)}
      SELECT public.expect_error(format('SELECT public.get_report_pack_activity_accounting(%L)',(SELECT id FROM public.monthly_report_packs LIMIT 1)),'Provider administrator access required');
      ${actor(admin)}
      INSERT INTO accounting SELECT public.get_report_pack_activity_accounting(id) FROM public.monthly_report_packs;
      RESET ROLE;
      SELECT public.assert_ok((SELECT (data->'freshness'->>'matchesLive')::boolean AND (data->'freshness'->>'liveEntries')::int=17 FROM accounting),'fresh pack matches live');
      SELECT public.assert_ok((SELECT data->'provenance'->'events'='{"inScope":15,"withLedger":2,"withoutLedger":13}'::jsonb
        AND data->'provenance'->'observations'='{"inScope":2,"withLedger":1,"withoutLedger":1}'::jsonb FROM accounting),'ledger provenance');
      SELECT public.assert_ok((SELECT data->'provenance'->'sources'->0 @> '{"sourceFile":"RM Patrol Log Oct.xlsx","sourceSheet":"Pest","batchStatus":"applied","batchRows":100,"events":2,"observations":0}'::jsonb FROM accounting),'source receipts');
      SELECT public.assert_ok((SELECT position('PRIVATE-' IN data::text)=0 FROM accounting),'foreign provider and client import receipts stay private');
      SELECT public.assert_ok((SELECT data->'clientMonth'='{"entries":20,"thisAgreement":17,"otherAgreements":1,"noAgreementPlace":2,"unlinkedPlaces":[{"place":"Gamma Unlinked","entries":2}]}'::jsonb FROM accounting),
        'client month: '||(SELECT (data->'clientMonth')::text FROM accounting));
      SELECT public.assert_ok((SELECT (data->'exceptions'->>'futureDated')::int=1 AND (data->'exceptions'->>'supersededDuplicates')::int=1
        AND data->'exceptions'->'sparseYears' @> '[{"year":2016,"entries":1}]'::jsonb FROM accounting),'exceptions: '||(SELECT (data->'exceptions')::text FROM accounting));

      BEGIN;
      UPDATE public.workshop_work_orders SET work_activity_code_id='${id(71)}' WHERE id='${wo(1)}';
      SELECT public.assert_ok((SELECT l->>'s'='gate' AND l->>'a'='inspection'
        FROM jsonb_array_elements(public.build_agreement_activity_report('${agreement}',${nz('2026-10-01 00:00')},${nz('2026-11-01 00:00')},2000)->'lines'->'lines') l
        WHERE l->>'j'='WO-1'),'a recorded gate inspection is not replaced by generic maintenance');
      UPDATE public.workshop_work_orders SET work_subject_code_id='${id(72)}',work_activity_code_id='${id(73)}' WHERE id='${wo(1)}';
      SELECT public.assert_ok((SELECT NOT (l ? 's') AND l->>'a'='maintenance'
        FROM jsonb_array_elements(public.build_agreement_activity_report('${agreement}',${nz('2026-10-01 00:00')},${nz('2026-11-01 00:00')},2000)->'lines'->'lines') l
        WHERE l->>'j'='WO-1'),'foreign workshop catalogue codes do not leak');
      ROLLBACK;

      BEGIN;
      UPDATE public.location_events SET payload=jsonb_set(payload,'{materials_used}','[{"material_type":"ammunition","calibre":".22"},{"material_type":"ammunition","calibre":".22","quantity":"unknown"}]') WHERE id='${ev(1)}';
      SELECT public.assert_ok(public.build_agreement_activity_report('${agreement}',${nz('2026-10-01 00:00')},${nz('2026-11-01 00:00')},2000)
        ->'report'->'pestControl'->'ammunition'='[{"calibre":".22","entries":1,"rounds":null}]'::jsonb,'unknown ammunition stays unknown');
      UPDATE public.location_events SET payload=jsonb_set(payload,'{materials_used}','[{"material_type":"ammunition","calibre":".22","quantity":0}]') WHERE id='${ev(1)}';
      SELECT public.assert_ok(public.build_agreement_activity_report('${agreement}',${nz('2026-10-01 00:00')},${nz('2026-11-01 00:00')},2000)
        ->'report'->'pestControl'->'ammunition'='[{"calibre":".22","entries":1,"rounds":0}]'::jsonb,'recorded zero ammunition remains zero');
      ROLLBACK;

      ${[
        [`UPDATE public.location_events SET payload=jsonb_set(payload,'{biosecurity_species_code}','"goat"') WHERE id='${ev(1)}'`, 'species'],
        [`UPDATE public.location_events SET payload=jsonb_set(payload,'{materials_used,0,quantity}','7') WHERE id='${ev(1)}'`, 'ammunition'],
        [`UPDATE public.location_zones SET name='Corrected reserve' WHERE id='${alpha}'`, 'place'],
        [`UPDATE public.location_events SET payload=jsonb_set(payload,'{job_number}','"J-CORRECTED"') WHERE id='${ev(1)}'`, 'job reference'],
        [`UPDATE public.location_events SET payload=jsonb_set(payload,'{comments}','"Three possums culled"') WHERE id='${ev(1)}'`, 'comment'],
        [`UPDATE public.incidents SET status='resolved' WHERE id='${inc(1)}'`, 'incident status'],
        [`INSERT INTO public.evidence_items(organization_id,module_key,evidence_kind,storage_path,location_event_id) VALUES ('${client}','patrol','photo','e/1b.jpg','${ev(1)}')`, 'photo'],
      ].map(([change, label]) => `
        BEGIN;
        ${change};
        ${actor(admin)}
        SELECT public.assert_ok(NOT (public.get_report_pack_activity_accounting(${pack})->'freshness'->>'matchesLive')::boolean,'${label} correction makes snapshot stale');
        RESET ROLE;
        ROLLBACK;
      `).join('\n')}

      BEGIN;
      CREATE TEMP TABLE capped_before AS
        SELECT public.build_agreement_activity_report('${agreement}',${nz('2026-10-01 00:00')},${nz('2026-11-01 00:00')},1) AS snapshot;
      UPDATE public.location_events SET payload=jsonb_set(payload,'{job_number}','"HIDDEN-CHANGE"') WHERE id='${ev(15)}';
      SELECT public.assert_ok((SELECT before.snapshot->'lines'=after.snapshot->'lines'
        AND before.snapshot->'report'->>'itemisedDigest' <> after.snapshot->'report'->>'itemisedDigest'
        FROM capped_before before CROSS JOIN LATERAL
          (SELECT public.build_agreement_activity_report('${agreement}',${nz('2026-10-01 00:00')},${nz('2026-11-01 00:00')},1) AS snapshot) after),
        'a correction beyond the appendix cap still changes its digest');
      ROLLBACK;

      BEGIN;
      INSERT INTO public.location_events(id,organization_id,zone_id,event_type,module_key,occurred_at,source,payload) VALUES
        ('${ev(19)}','${client}','${alpha}','patrol_visit','patrol',${nz('2026-09-30 23:30')},'rm_patrol_log_import','{}');
      ${actor(admin)}
      SELECT public.assert_ok(public.generate_due_report_packs('2026-09-01','2026-09-30','${agreement}')=1,'DST-change month generated in UTC session');
      RESET ROLE;
      SELECT public.assert_ok((SELECT data->'activityReport'->'totals'->>'entries'='1' AND data->>'operationalEvents'='1'
        FROM public.monthly_report_packs WHERE period_start='2026-09-01'),'September ends at Auckland midnight after DST change');
      ROLLBACK;

      INSERT INTO public.location_events(id,organization_id,zone_id,event_type,module_key,occurred_at,source,payload) VALUES
        ('${ev(18)}','${client}','${alpha}','patrol_visit','patrol',${nz('2026-10-25 09:00')},'rm_patrol_log_import','{"work_activity_code":"cull","biosecurity_species_code":"cat"}');
      TRUNCATE accounting;
      ${actor(admin)}
      INSERT INTO accounting SELECT public.get_report_pack_activity_accounting(id) FROM public.monthly_report_packs;
      RESET ROLE;
      SELECT public.assert_ok((SELECT NOT (data->'freshness'->>'matchesLive')::boolean
        AND data->'freshness'->'changedCategories'='[{"code":"pest_control","frozen":3,"live":4}]'::jsonb FROM accounting),'stale pack is flagged');

      UPDATE public.monthly_report_packs SET status='sent' WHERE service_agreement_id='${agreement}';
      ${actor(admin)}
      SELECT public.assert_ok(public.generate_due_report_packs('2026-10-01','2026-10-31','${agreement}')=0,'sent pack is not regenerated');
      RESET ROLE;
      SELECT public.assert_ok(jsonb_array_length(${lines}->'lines')=17,'sent pack keeps its frozen lines');
    `;
    try { docker(['exec', '-i', name, 'psql', '-X', '-q', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], setup); }
    catch (failure) { throw new Error(`${failure.stdout?.slice(-3000) ?? ''}\n${failure.stderr ?? failure.message}`); }
  } finally {
    if (created) docker(['rm', '--force', name]);
  }
});
