const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261110103000_working_zone_policies.sql'), 'utf8');

test('working-zone policies use governed, versioned and source-confirmed writes', () => {
  assert.match(migration, /crm_actor_can_manage_location/);
  assert.match(migration, /source_confirmed/);
  assert.match(migration, /configuration_version <> p_expected_version/);
  assert.match(migration, /public\.manage_parking_zone_rule/);
  assert.match(migration, /INSERT INTO public\.zone_compliance_matrix/);
  assert.match(migration, /SET is_current = false/);
  assert.match(migration, /different input/);
});

test('working-zone policy authorization, persistence, history and replay hold in PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 90000,
}, () => {
  const name = `fcm-zone-policy-${process.pid}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    docker(['run', '-d', '--rm', '--network', 'none', '--memory', '512m', '--cpus', '1', '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { timeout: 2000, stdio: 'ignore' }).status === 0) { ready = true; break; }
    }
    assert.equal(ready, true);
    const sql = `CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('fixture.uid',true),'')::uuid $$;
CREATE TABLE public.user_profiles(id uuid PRIMARY KEY,organization_id uuid,deactivated_at timestamptz,role text);
CREATE TABLE public.location_zones(id uuid PRIMARY KEY,organization_id uuid,location_id uuid,module_key text,rule_type text,configuration_version integer DEFAULT 1,
 parking_time_limit_minutes integer,parking_disabled_multiplier numeric,parking_signage_photo_url text,bylaw_clause text,bylaw_source_url text,nightly_limit_consecutive integer,nightly_limit_monthly integer,scv_required boolean);
CREATE TABLE public.zone_compliance_matrix(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,zone_id uuid,version integer,is_current boolean,
 max_consecutive_nights integer,max_nights_per_month integer,scv_required boolean,effective_from date,bylaw_clause text,bylaw_source_url text,notes text,created_by uuid,
 max_nights_per_year integer,allowed_vehicle_types text[],no_camping_start_time time,no_camping_end_time time,restricted_from_date date,restricted_to_date date);
CREATE TABLE public.audit_log(id uuid DEFAULT gen_random_uuid(),organization_id uuid,actor_user_id uuid,action text,target_table text,target_id uuid,metadata jsonb);
CREATE TABLE public.parking_rule_matrix(id uuid DEFAULT gen_random_uuid(),organization_id uuid,zone_id uuid,version integer,is_current boolean,effective_from date,
 time_limit_minutes integer,grace_period_minutes integer,disabled_multiplier numeric,legislative_text text,require_photo_evidence boolean,infringement_fee numeric,auto_escalate_overstay boolean,notes text,created_by uuid);
CREATE FUNCTION public.is_admin_for_org(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT EXISTS(SELECT 1 FROM public.user_profiles WHERE id=auth.uid() AND organization_id=$1 AND role='admin' AND deactivated_at IS NULL) $$;
CREATE FUNCTION public.crm_actor_can_manage_location(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='33333333-3333-4333-8333-333333333333'::uuid $$;
CREATE FUNCTION public.manage_parking_zone_rule(uuid,uuid,integer,integer,numeric,text,text) RETURNS public.location_zones LANGUAGE plpgsql AS $$
DECLARE result public.location_zones; BEGIN
 IF $4 IS NULL OR $4 NOT BETWEEN 1 AND 1440 OR $5 IS NULL OR $5 NOT BETWEEN 1 AND 4 OR $7 IS NULL THEN RAISE EXCEPTION 'Invalid signage policy'; END IF;
 UPDATE public.location_zones SET parking_time_limit_minutes=$4,parking_disabled_multiplier=$5,parking_signage_photo_url=$7,configuration_version=configuration_version+1 WHERE id=$2 RETURNING * INTO result; RETURN result; END $$;
INSERT INTO public.user_profiles VALUES('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',NULL,'admin'),('99999999-9999-4999-8999-999999999999','22222222-2222-4222-8222-222222222222',NULL,'officer');
INSERT INTO public.location_zones(id,organization_id,location_id,module_key,rule_type) VALUES
 ('44444444-4444-4444-8444-444444444444','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','freedom_camping','overnight_limited'),
 ('55555555-5555-4555-8555-555555555555','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','parking_enforcement','restricted');
${migration}
SET ROLE authenticated;
SELECT set_config('fixture.uid','11111111-1111-4111-8111-111111111111',false);
SELECT public.save_working_zone_policy('66666666-6666-4666-8666-666666666666','44444444-4444-4444-8444-444444444444',1,'{"source_ref":"Synthetic council policy clause 4","source_confirmed":true,"max_consecutive_nights":2,"max_nights_per_month":4,"scv_required":true}'::jsonb);
SELECT public.save_working_zone_policy('66666666-6666-4666-8666-666666666666','44444444-4444-4444-8444-444444444444',1,'{"source_ref":"Synthetic council policy clause 4","source_confirmed":true,"max_consecutive_nights":2,"max_nights_per_month":4,"scv_required":true}'::jsonb);
DO $$ BEGIN
 BEGIN PERFORM public.save_working_zone_policy('77777777-7777-4777-8777-777777777777','44444444-4444-4444-8444-444444444444',1,'{"source_ref":"Synthetic changed policy","source_confirmed":true}'::jsonb); RAISE EXCEPTION 'Stale policy accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Working zone changed%' THEN RAISE; END IF; END;
END $$;
SELECT public.save_working_zone_policy('77777777-7777-4777-8777-777777777777','44444444-4444-4444-8444-444444444444',2,'{"source_ref":"Synthetic council policy clause 5","source_confirmed":true,"max_consecutive_nights":3,"max_nights_per_month":5}'::jsonb);
SELECT public.save_working_zone_policy('88888888-8888-4888-8888-888888888888','55555555-5555-4555-8555-555555555555',1,'{"source_ref":"Synthetic photographed P90 sign","source_confirmed":true,"time_limit_minutes":90,"disabled_multiplier":2,"signage_photo_path":"synthetic-sign.jpg"}'::jsonb);
DO $$ BEGIN
 IF (public.get_working_zone_policy('44444444-4444-4444-8444-444444444444')->>'policy_version')::integer <> 2 THEN RAISE EXCEPTION 'Camping version not persisted'; END IF;
 IF (public.get_working_zone_policy('55555555-5555-4555-8555-555555555555')->'policy'->>'time_limit_minutes')::integer <> 90 THEN RAISE EXCEPTION 'Parking policy not persisted'; END IF;
END $$;
SELECT set_config('fixture.uid','99999999-9999-4999-8999-999999999999',false);
DO $$ BEGIN
 BEGIN PERFORM public.get_working_zone_policy('44444444-4444-4444-8444-444444444444'); RAISE EXCEPTION 'Officer read allowed'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Active administrator authority%' THEN RAISE; END IF; END;
END $$;
RESET ROLE;
DO $$ BEGIN
 IF (SELECT count(*) FROM public.zone_compliance_matrix) <> 2 OR (SELECT count(*) FROM public.zone_compliance_matrix WHERE is_current) <> 1 THEN RAISE EXCEPTION 'Policy history or replay is invalid'; END IF;
END $$;`;
    docker(['exec', '-i', name, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], sql);
  } finally { spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 10000 }); }
});