'use strict';
// manage_identity_vehicle erased an organisation's vehicle note whenever p_fields omitted "notes" (NZTA owner
// review passes '{}', and in-app Bob's register step can meet a plate another administrator registered a moment
// earlier). The migration makes an omitted note mean "keep". Synthetic data only.
const test = require('node:test');
if (process.env.BOB_TEST_POSTGRES === '1') require('./person-record-operations-migration.test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

// The CI PostgreSQL step lists this file; related identity migration tests ride along without a workflow edit.
if (process.env.BOB_TEST_POSTGRES === '1') require('./record-identity-person-details-migration.test');
if (process.env.BOB_TEST_POSTGRES === '1') require('./cctv-enterprise-inference-migration.test');
if (process.env.BOB_TEST_POSTGRES === '1') require('./cctv-inference-claim-gate-migration.test');
if (process.env.BOB_TEST_POSTGRES === '1') require('./cctv-recognition-quality-gates.test');
if (process.env.BOB_TEST_POSTGRES === '1') require('./timesheet-submission-concurrency-migration.test');
if (process.env.BOB_TEST_POSTGRES === '1') require('./timesheet-approved-correction-migration.test');
if (process.env.BOB_TEST_POSTGRES === '1') require('./website-page-view-analytics-migration.test');
if (process.env.BOB_TEST_POSTGRES === '1') require('./website-posts-migration.test');
if (process.env.BOB_TEST_POSTGRES === '1') require('./officer-breadcrumb-admin-officer-migration.test');
if (process.env.BOB_TEST_POSTGRES === '1') require('./officer-recovery-readiness-migration.test');
if (process.env.BOB_TEST_POSTGRES === '1') require('./payroll-export-receipt-migration.test');
if (process.env.BOB_TEST_POSTGRES === '1') require('./invitation-access-states-migration.test');
if (process.env.BOB_TEST_POSTGRES === '1') require('./static-arrival-start-gate-migration.test');
if (process.env.BOB_TEST_POSTGRES === '1') require('./static-roster-contact-migration.test');
if (process.env.BOB_TEST_POSTGRES === '1') require('./roster-shift-amendment-migration.test');
if (process.env.BOB_TEST_POSTGRES === '1') require('./ad-hoc-static-shift-post-migration.test');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261101180000_manage_identity_vehicle_preserve_notes.sql'), 'utf8');
const schema = fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8');
const liveStart = schema.indexOf('CREATE OR REPLACE FUNCTION "public"."manage_identity_vehicle"');
const keepRule = "org_notes = CASE WHEN NOT coalesce(p_fields ? 'notes', false) THEN org_notes\n      WHEN v_note IS NULL";
const eraseRule = 'org_notes = CASE WHEN v_note IS NULL';
const migratedFunction = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION'), migration.indexOf('$function$;') + '$function$;'.length);
// The pre-fix definition is rebuilt from the migration, because schema.sql is regenerated from the live catalog
// after release and then already carries the fix.
const preFixFunction = migratedFunction.replace(keepRule, eraseRule);

test('the migration changes only the omitted-notes rule and keeps the existing grants', () => {
  assert.ok(liveStart > 0);
  assert.notEqual(preFixFunction, migratedFunction, 'the pre-fix definition differs only by the omitted-notes rule');
  assert.match(migration, /org_notes = CASE WHEN NOT coalesce\(p_fields \? 'notes', false\) THEN org_notes\n\s+WHEN v_note IS NULL THEN org_notes - p_organization_id::text\n\s+ELSE jsonb_set\(/);
  assert.match(migration, /SECURITY DEFINER\n SET search_path TO 'public'/);
  assert.doesNotMatch(migration, /\b(GRANT|REVOKE|DROP)\b/);
});

test('an omitted note is kept and an empty note still clears, against disposable PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-vehicle-notes-${randomUUID()}`;
  const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    const orgA = '0a000000-0000-4000-8000-00000000000a';
    const orgB = '0b000000-0000-4000-8000-00000000000b';
    const admin = 'a0000000-0000-4000-8000-000000000001';
    const call = (org, fields, reason = 'Synthetic test') =>
      `SELECT public.manage_identity_vehicle('${org}', NULL, 'TST123', ${fields === null ? 'NULL' : `'${JSON.stringify(fields)}'::jsonb`}, '${reason}')`;
    const note = (org) => `(SELECT org_notes->'${org}'->>'text' FROM public.canonical_vehicles WHERE plate_number = 'TST123')`;
    const sql = `
      DO $$ BEGIN
        CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      END $$;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $fn$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;
      CREATE FUNCTION public.normalize_plate_number(p_plate text) RETURNS text LANGUAGE sql IMMUTABLE AS
        $fn$ SELECT nullif(upper(regexp_replace(coalesce(p_plate, ''), '[^A-Za-z0-9]', '', 'g')), '') $fn$;
      CREATE FUNCTION public.is_admin_for_org(p_organization_id uuid) RETURNS boolean LANGUAGE sql STABLE AS
        $fn$ SELECT auth.uid() IS NOT NULL $fn$;
      CREATE FUNCTION public.is_grand_master() RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT false $fn$;
      CREATE FUNCTION public.jsonb_object_length(p_value jsonb) RETURNS integer LANGUAGE sql IMMUTABLE AS
        $fn$ SELECT count(*)::integer FROM jsonb_object_keys(coalesce(p_value, '{}'::jsonb)) $fn$;
      CREATE TABLE public.canonical_vehicles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plate_number text NOT NULL UNIQUE, make text, model text, year integer,
        colour text, body_type text, rego_expiry date, wof_expiry date, cof_expiry date, org_notes jsonb NOT NULL DEFAULT '{}'::jsonb,
        compliance_source text, compliance_checked_at timestamptz, updated_at timestamptz);
      CREATE TABLE public.canonical_vehicle_links (canonical_vehicle_id uuid, source_system text, source_table text, source_key text,
        metadata jsonb, UNIQUE (source_system, source_table, source_key));
      CREATE TABLE public.cctv_entity_observations (canonical_vehicle_id uuid, organization_id uuid);
      CREATE TABLE public.observations (canonical_vehicle_id uuid, organization_id uuid);
      CREATE TABLE public.audit_log (organization_id uuid, actor_user_id uuid, action text, target_table text, target_id uuid, metadata jsonb);
      CREATE FUNCTION public.ensure_canonical_vehicle(p_plate text, p_make text, p_model text, p_colour text, p_source_table text,
        p_source_key text, p_observed_at timestamptz) RETURNS uuid LANGUAGE sql AS
        $fn$ INSERT INTO public.canonical_vehicles (plate_number, make, model, colour) VALUES (p_plate, p_make, p_model, p_colour) RETURNING id $fn$;
      CREATE FUNCTION pg_temp.check(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $fn$
      BEGIN IF NOT coalesce(ok, false) THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $fn$;
      SELECT set_config('request.jwt.claim.sub', '${admin}', false);

      -- The pre-fix definition: an omitted note erases the organisation's note.
      ${preFixFunction}
      ${call(orgA, { make: 'Toyota', notes: 'Gate code 1234 note' }, 'Registered in the workspace')};
      SELECT pg_temp.check(${note(orgA)} = 'Gate code 1234 note', 'the workspace sets a note');
      ${call(orgA, {}, 'NZTA registered-owner identity reviewed')};
      SELECT pg_temp.check(${note(orgA)} IS NULL, 'before the fix, an omitted note was erased');

      -- The migration.
      ${migration}
      SELECT pg_temp.check(obj_description('public.manage_identity_vehicle(uuid,uuid,text,jsonb,text)'::regprocedure, 'pg_proc')
        LIKE 'Organisation identity-registry vehicle upsert%', 'the function documents the omitted-key rule');
      ${call(orgA, { notes: 'Gate code 1234 note' }, 'Workspace note restored')};
      ${call(orgB, { notes: 'Other organisation note' }, 'Other organisation note')};
      ${call(orgA, { make: 'Toyota' }, 'Bob chat (confirmed by user): register vehicle')};
      SELECT pg_temp.check(${note(orgA)} = 'Gate code 1234 note', 'a register call without notes keeps the note');
      ${call(orgA, {}, 'NZTA registered-owner identity reviewed')};
      SELECT pg_temp.check(${note(orgA)} = 'Gate code 1234 note', 'an empty field set keeps the note');
      ${call(orgA, null, 'Null fields')};
      SELECT pg_temp.check(${note(orgA)} = 'Gate code 1234 note', 'null fields keep the note');
      ${call(orgA, { notes: '   ' }, 'Workspace cleared the note')};
      SELECT pg_temp.check(${note(orgA)} IS NULL, 'a present but empty note still clears it');
      ${call(orgA, { notes: 'Updated note' }, 'Workspace set a new note')};
      SELECT pg_temp.check(${note(orgA)} = 'Updated note', 'a present note still sets it');
      SELECT pg_temp.check(${note(orgB)} = 'Other organisation note', 'another organisation''s note is never touched');
      SELECT pg_temp.check((SELECT count(*) FROM public.canonical_vehicles) = 1, 'the plate stays one canonical vehicle');
      SELECT pg_temp.check((SELECT count(*) FROM public.audit_log WHERE action = 'identity_vehicle_upserted') = 9, 'every call is audited');
    `;
    execFileSync('docker', ['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-q'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});
