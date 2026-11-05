'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFile, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261105150755_static_roster_operational_contact.sql'), 'utf8');
const schema = fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8');
const liveFunction = (name) => {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"`);
  assert.notEqual(start, -1, `${name} must exist in the live schema snapshot`);
  const end = schema.indexOf('$function$;', start);
  assert.notEqual(end, -1, `${name} must have a complete body`);
  return schema.slice(start, end + '$function$;'.length);
};
const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

test('static roster contacts use scoped reads and governed writes', () => {
  assert.match(migration, /alter table public\.roster_slot_contacts enable row level security/i);
  assert.match(migration, /revoke all on table public\.roster_slot_contacts from public, anon, authenticated/i);
  assert.match(migration, /coalesce\(sp\.user_id, sp\.id\) = \(select auth\.uid\(\)\)/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /v_existing\.version is distinct from p_expected_version/i);
  assert.doesNotMatch(migration, /jsonb_build_object\([^;]*['"]contact_phone['"]\s*,\s*v_phone/i);
});

test('contacts, authorization, retries and atomicity against disposable PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 120_000,
}, async () => {
  const container = `fcm-roster-contact-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const execDocker = promisify(execFile);
  let created = false;
  try {
    docker(['run', '--detach', '--name', container, '--network', 'none', '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');

    const sql = `
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
        AS $fn$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;
      CREATE TABLE user_profiles(id uuid PRIMARY KEY, organization_id uuid, role text, deactivated_at timestamptz);
      CREATE TABLE staff_profiles(id uuid PRIMARY KEY, user_id uuid, organization_id uuid, work_ready boolean);
      CREATE TABLE roster_work_units(id uuid PRIMARY KEY, organization_id uuid, work_unit_type text, active boolean);
      CREATE TABLE roster_slots(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, work_unit_id uuid NOT NULL,
        staff_id uuid, scheduled_start timestamptz NOT NULL, scheduled_end timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'draft', linked_shift_id uuid, client_request_id uuid NOT NULL,
        notes text, created_by uuid, UNIQUE(organization_id, client_request_id)
      );
      CREATE TABLE staff_branch_authorisations(user_id uuid, branch_org_id uuid, status text);
      CREATE TABLE leave_requests(staff_id uuid, status text, starts_on date, ends_on date);
      CREATE TABLE audit_log(organization_id uuid, actor_user_id uuid, action text, target_table text, target_id uuid, metadata jsonb);
      CREATE FUNCTION public.is_admin_for_org(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = '' AS $fn$
          SELECT EXISTS (SELECT 1 FROM public.user_profiles p WHERE p.id = auth.uid() AND p.deactivated_at IS NULL
            AND (p.role = 'grand_master' OR (p.role IN ('master','admin','admin_officer') AND p.organization_id = target)))
        $fn$;
      CREATE FUNCTION public.staff_has_roster_availability_conflict(uuid, timestamptz, timestamptz) RETURNS boolean
        LANGUAGE sql AS $fn$ SELECT false $fn$;
      CREATE FUNCTION public.staff_fatigue_conflict(uuid, timestamptz, timestamptz, uuid) RETURNS text
        LANGUAGE sql AS $fn$ SELECT NULL::text $fn$;
      ${liveFunction('create_roster_slot')}
      ${liveFunction('update_roster_slot')}
      GRANT SELECT ON user_profiles, staff_profiles, roster_work_units, roster_slots TO authenticated;
      ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
      ALTER TABLE staff_profiles ENABLE ROW LEVEL SECURITY;
      ALTER TABLE roster_work_units ENABLE ROW LEVEL SECURITY;
      ALTER TABLE roster_slots ENABLE ROW LEVEL SECURITY;
      CREATE POLICY profile_read ON user_profiles FOR SELECT TO authenticated
        USING (id = auth.uid() OR public.is_admin_for_org(organization_id));
      CREATE POLICY staff_read ON staff_profiles FOR SELECT TO authenticated
        USING (id = auth.uid() OR user_id = auth.uid() OR public.is_admin_for_org(organization_id));
      CREATE POLICY unit_read ON roster_work_units FOR SELECT TO authenticated
        USING (organization_id = (SELECT p.organization_id FROM user_profiles p WHERE p.id = auth.uid())
          OR public.is_admin_for_org(organization_id));
      CREATE POLICY slot_read ON roster_slots FOR SELECT TO authenticated
        USING (public.is_admin_for_org(organization_id) OR EXISTS (
          SELECT 1 FROM staff_profiles sp WHERE sp.id = roster_slots.staff_id AND (sp.user_id = auth.uid() OR sp.id = auth.uid())
        ));
      CREATE FUNCTION pg_temp.check(ok boolean, label text) RETURNS void LANGUAGE plpgsql
        AS $fn$ BEGIN IF NOT coalesce(ok,false) THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $fn$;
      CREATE FUNCTION pg_temp.denied(command text, expected text) RETURNS void LANGUAGE plpgsql AS $fn$
      BEGIN
        BEGIN EXECUTE command; EXCEPTION WHEN OTHERS THEN IF position(expected in SQLERRM)>0 THEN RETURN; END IF; RAISE; END;
        RAISE EXCEPTION 'Expected refusal: %',expected;
      END $fn$;
      INSERT INTO user_profiles VALUES
        ('${id(1)}','${id(100)}','admin',NULL),
        ('${id(2)}','${id(100)}','officer',NULL),
        ('${id(3)}','${id(100)}','officer',now()),
        ('${id(4)}','${id(200)}','admin',NULL),
        ('${id(5)}','${id(100)}','officer',NULL),
        ('${id(6)}','${id(100)}','officer',NULL),
        ('${id(7)}','${id(100)}','officer',NULL),
        ('${id(8)}','${id(100)}','admin_officer',NULL);
      INSERT INTO staff_profiles VALUES
        ('${id(21)}','${id(2)}','${id(100)}',true),
        ('${id(22)}','${id(3)}','${id(100)}',true),
        ('${id(5)}','${id(6)}','${id(100)}',true);
      INSERT INTO roster_work_units VALUES
        ('${id(10)}','${id(100)}','static',true),
        ('${id(11)}','${id(100)}','patrol',true);
      INSERT INTO roster_slots(id,organization_id,work_unit_id,staff_id,scheduled_start,scheduled_end,status,client_request_id,created_by) VALUES
        ('${id(301)}','${id(100)}','${id(10)}','${id(21)}','2099-01-01 08:00Z','2099-01-01 16:00Z','draft','${id(401)}','${id(1)}'),
        ('${id(302)}','${id(100)}','${id(10)}','${id(21)}','2099-01-02 08:00Z','2099-01-02 16:00Z','published','${id(402)}','${id(1)}'),
        ('${id(303)}','${id(100)}','${id(10)}','${id(21)}','2099-01-03 08:00Z','2099-01-03 16:00Z','accepted','${id(403)}','${id(1)}'),
        ('${id(304)}','${id(100)}','${id(10)}','${id(21)}','2099-01-04 08:00Z','2099-01-04 16:00Z','declined','${id(404)}','${id(1)}'),
        ('${id(305)}','${id(100)}','${id(10)}','${id(21)}','2099-01-05 08:00Z','2099-01-05 16:00Z','cancelled','${id(405)}','${id(1)}'),
        ('${id(306)}','${id(100)}','${id(10)}','${id(5)}','2099-01-06 08:00Z','2099-01-06 16:00Z','published','${id(406)}','${id(1)}'),
        ('${id(307)}','${id(100)}','${id(10)}','${id(22)}','2099-01-07 08:00Z','2099-01-07 16:00Z','published','${id(407)}','${id(1)}'),
        ('${id(308)}','${id(100)}','${id(11)}','${id(21)}','2099-01-08 08:00Z','2099-01-08 16:00Z','published','${id(408)}','${id(1)}');
      ${migration}
      INSERT INTO roster_slot_contacts(roster_slot_id,contact_name,contact_phone,version,updated_by)
        SELECT id,'Synthetic contact','03 555 1234','${id(700)}','${id(1)}' FROM roster_slots;
      SELECT pg_temp.check(NOT has_table_privilege('anon','public.roster_slot_contacts','SELECT'),'anonymous cannot read');
      SELECT pg_temp.check(NOT has_table_privilege('authenticated','public.roster_slot_contacts','INSERT'),'authenticated cannot write directly');
      SELECT pg_temp.check(NOT has_function_privilege('anon','public.set_roster_slot_contact(uuid,text,text,text,uuid)','EXECUTE'),'anonymous cannot call setter');
      SELECT pg_temp.check(NOT has_function_privilege('anon','public.create_static_roster_slot_with_contact(uuid,uuid,uuid,timestamptz,timestamptz,boolean,text,text,text)','EXECUTE'),'anonymous cannot create');
      SET ROLE authenticated;
      SELECT set_config('request.jwt.claim.sub','${id(2)}',false);
      SELECT pg_temp.check((SELECT count(*)=2 FROM roster_slot_contacts),'assigned active officer sees published/accepted static slots only');
      SELECT pg_temp.check(NOT EXISTS(SELECT 1 FROM roster_slot_contacts WHERE roster_slot_id IN ('${id(301)}','${id(304)}','${id(305)}','${id(308)}')),'draft, declined, cancelled and nonstatic contacts withheld');
      SELECT pg_temp.denied($sql$ INSERT INTO public.roster_slot_contacts(roster_slot_id,contact_name,updated_by) VALUES ('${id(301)}','Not allowed','${id(2)}') $sql$,'permission denied');
      SELECT pg_temp.denied($sql$ SELECT public.set_roster_slot_contact('${id(302)}','published','Not allowed',NULL,'${id(700)}') $sql$,'Roster administrator access required');
      SELECT set_config('request.jwt.claim.sub','${id(3)}',false);
      SELECT pg_temp.check((SELECT count(*)=0 FROM roster_slot_contacts),'deactivated assigned officer sees none');
      SELECT set_config('request.jwt.claim.sub','${id(4)}',false);
      SELECT pg_temp.check((SELECT count(*)=0 FROM roster_slot_contacts),'other organisation administrator sees none');
      SELECT set_config('request.jwt.claim.sub','${id(7)}',false);
      SELECT pg_temp.check((SELECT count(*)=0 FROM roster_slot_contacts),'unrelated officer sees none');
      SELECT set_config('request.jwt.claim.sub','${id(5)}',false);
      SELECT pg_temp.check((SELECT count(*)=0 FROM roster_slot_contacts),'staff primary key cannot override a different linked user');
      SELECT set_config('request.jwt.claim.sub','${id(6)}',false);
      SELECT pg_temp.check((SELECT count(*)=1 FROM roster_slot_contacts),'linked staff user may read their own published contact');
      SELECT set_config('request.jwt.claim.sub','${id(8)}',false);
      SELECT pg_temp.check((SELECT count(*)=8 FROM roster_slot_contacts),'admin officer has administrator parity');
      SELECT set_config('request.jwt.claim.sub','${id(1)}',false);
      SELECT pg_temp.denied($sql$ SELECT public.set_roster_slot_contact('${id(302)}','draft','Wrong',NULL,'${id(700)}') $sql$,'changed from expected status');
      SELECT pg_temp.denied($sql$ SELECT public.set_roster_slot_contact('${id(305)}','cancelled','Wrong',NULL,'${id(700)}') $sql$,'completed or cancelled');
      SELECT pg_temp.denied($sql$ SELECT public.set_roster_slot_contact('${id(308)}','published','Wrong',NULL,'${id(700)}') $sql$,'Static roster assignment required');
      SELECT pg_temp.denied($sql$ SELECT public.set_roster_slot_contact('${id(302)}','published',E'Bad\\nname',NULL,'${id(700)}') $sql$,'one line');
      SELECT pg_temp.denied($sql$ SELECT public.set_roster_slot_contact('${id(302)}','published','Valid','123 x','${id(700)}') $sql$,'valid contact phone');
      SELECT pg_temp.denied($sql$ SELECT public.set_roster_slot_contact('${id(302)}','published','Valid','+64 (0)123456789012345678','${id(700)}') $sql$,'valid contact phone');
      SELECT pg_temp.check((public.set_roster_slot_contact('${id(302)}','published','Replacement','+64 (0)12345678901234567','${id(700)}')->>'changed')::boolean,'valid contact is saved');
      SELECT pg_temp.check(NOT (public.set_roster_slot_contact('${id(302)}','published','Replacement','+64 (0)12345678901234567','${id(700)}')->>'changed')::boolean,'identical retry is harmless');
      SELECT pg_temp.denied($sql$ SELECT public.set_roster_slot_contact('${id(302)}','published','Stale writer',NULL,'${id(700)}') $sql$,'Shift contact changed');
      SELECT pg_temp.check((SELECT contact_name='Replacement' FROM roster_slot_contacts WHERE roster_slot_id='${id(302)}'),'stale contact edit leaves winner intact');
      SELECT pg_temp.check((public.set_roster_slot_contact('${id(302)}','published',NULL,NULL,(SELECT version FROM roster_slot_contacts WHERE roster_slot_id='${id(302)}'))->>'changed')::boolean,'contact can be cleared');
      SELECT pg_temp.check(NOT EXISTS(SELECT 1 FROM roster_slot_contacts WHERE roster_slot_id='${id(302)}'),'cleared designation is removed');
      SELECT pg_temp.denied($sql$ SELECT public.create_static_roster_slot_with_contact('${id(500)}','${id(10)}',NULL,'2099-02-01 08:00Z','2099-02-01 16:00Z',false,'Atomic','Synthetic name','bad phone') $sql$,'valid contact phone');
      SELECT pg_temp.check(NOT EXISTS(SELECT 1 FROM roster_slots WHERE client_request_id='${id(500)}'),'invalid contact rolls back slot creation');
      SELECT pg_temp.check((public.create_static_roster_slot_with_contact('${id(501)}','${id(10)}',NULL,'2099-02-02 08:00Z','2099-02-02 16:00Z',false,'Same','Synthetic name','03 555 1234')).client_request_id='${id(501)}','valid atomic slot creation');
      SELECT pg_temp.check((public.create_static_roster_slot_with_contact('${id(501)}','${id(10)}',NULL,'2099-02-02 08:00Z','2099-02-02 16:00Z',false,'Same','Synthetic name','03 555 1234')).client_request_id='${id(501)}','same request can be retried');
      SELECT pg_temp.denied($sql$ SELECT public.create_static_roster_slot_with_contact('${id(501)}','${id(10)}',NULL,'2099-02-02 08:00Z','2099-02-02 16:00Z',false,'Same','Different','03 555 1234') $sql$,'different roster assignment');
      SELECT pg_temp.denied($sql$ SELECT public.create_static_roster_slot_with_contact('${id(501)}','${id(10)}',NULL,'2099-02-02 08:00Z','2099-02-02 16:00Z',true,'Same','Synthetic name','03 555 1234') $sql$,'different roster assignment');
      SELECT pg_temp.denied($sql$ SELECT public.update_static_roster_slot_with_contact('${id(301)}','draft','${id(21)}','2099-01-01 09:00Z','2099-01-01 17:00Z','Changed','Name','bad phone','${id(700)}') $sql$,'valid contact phone');
      SELECT pg_temp.check((SELECT scheduled_start='2099-01-01 08:00Z' AND notes IS NULL FROM roster_slots WHERE id='${id(301)}'),'invalid contact rolls back draft edit');
      SELECT pg_temp.check((public.update_static_roster_slot_with_contact('${id(301)}','draft','${id(21)}','2099-01-01 09:00Z','2099-01-01 17:00Z','Changed','Draft contact','03 555 1234','${id(700)}')).id='${id(301)}','draft and contact update together');
      SELECT pg_temp.denied($sql$ SELECT public.update_static_roster_slot_with_contact('${id(301)}','draft','${id(21)}','2099-01-01 10:00Z','2099-01-01 18:00Z','Lost change','Old contact',NULL,'${id(700)}') $sql$,'Shift contact changed');
      SELECT pg_temp.check((SELECT scheduled_start='2099-01-01 09:00Z' AND notes='Changed' FROM roster_slots WHERE id='${id(301)}'),'stale draft contact rolls back whole edit');
      RESET ROLE;
      SELECT pg_temp.check((SELECT count(*)=1 FROM roster_slots WHERE client_request_id='${id(501)}'),'retry created one slot');
      SELECT pg_temp.check((SELECT count(*)=1 FROM audit_log WHERE action='roster_slot_created' AND target_id=(SELECT id FROM roster_slots WHERE client_request_id='${id(501)}')),'retry has one creation audit');
      SELECT pg_temp.check(NOT EXISTS(SELECT 1 FROM audit_log WHERE action='roster_slot_contact_changed' AND (metadata::text LIKE '%Replacement%' OR metadata::text LIKE '%555%' OR metadata::text LIKE '%Draft contact%')),'audit contains presence flags, not contact values');
      CREATE FUNCTION public.test_slow_roster_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN IF NEW.notes='concurrency' THEN PERFORM pg_sleep(0.6); END IF; RETURN NEW; END $fn$;
      CREATE TRIGGER slow_test_insert BEFORE INSERT ON public.roster_slots FOR EACH ROW EXECUTE FUNCTION public.test_slow_roster_insert();
    `;
    docker(['exec', '-i', container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], sql);

    const concurrently = async (request, firstContact, secondContact) => {
      const call = (contact) => {
        const command = `SET "request.jwt.claim.sub"='${id(1)}'; SET ROLE authenticated; SELECT (public.create_static_roster_slot_with_contact('${request}','${id(10)}',NULL,'2099-03-01 08:00Z','2099-03-01 16:00Z',false,'concurrency','${contact}','03 555 1234')).id;`;
        return execDocker('docker', ['exec', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', command], { encoding: 'utf8' });
      };
      return Promise.allSettled([call(firstContact), call(secondContact)]);
    };
    const same = await concurrently(id(510), 'Same contact', 'Same contact');
    assert.ok(same.every((result) => result.status === 'fulfilled'), 'concurrent identical requests both succeed');
    assert.equal(same[0].value.stdout.trim(), same[1].value.stdout.trim(), 'concurrent retries return the same slot');
    const conflict = await concurrently(id(511), 'Contact A', 'Contact B');
    assert.equal(conflict.filter((result) => result.status === 'fulfilled').length, 1, 'one conflicting concurrent request wins');
    const rejected = conflict.find((result) => result.status === 'rejected');
    assert.match(rejected.reason.stderr, /Request ID already used for a different roster assignment/);
    const counts = docker(['exec', container, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-c',
      `SELECT count(*) FROM roster_slots WHERE client_request_id IN ('${id(510)}','${id(511)}');`]);
    assert.equal(counts.trim(), '2', 'each concurrent request ID created one slot');
  } finally {
    if (created) docker(['rm', '--force', container]);
  }
});
