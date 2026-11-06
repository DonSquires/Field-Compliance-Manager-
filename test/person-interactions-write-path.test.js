const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'supabase', 'schema.sql'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20261106130000_person_interactions_write_path.sql'), 'utf8');
const catalogFunction = (name) => {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  assert.ok(start >= 0, `Missing catalog function ${name}`);
  const end = schema.indexOf('$function$;', start);
  assert.ok(end >= 0, `Missing function body for ${name}`);
  return schema.slice(start, end + '$function$;'.length);
};

test('person interaction RPCs are signed-in only, definer-owned and audited', () => {
  for (const signature of [
    'record_person_interaction\\(uuid, uuid, text, text, uuid, text, uuid, uuid, timestamptz, text, jsonb\\)',
    'get_person_interactions\\(uuid, integer\\)',
    'review_person_detail_update\\(uuid, text, text\\)',
    'get_pending_person_detail_updates\\(integer\\)',
  ]) {
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature} FROM PUBLIC, anon;`));
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature} TO authenticated, service_role;`));
  }
  assert.equal((migration.match(/SECURITY DEFINER\s+SET search_path TO 'public'/g) || []).length, 4);
  // The internal apply helper is never callable by signed-in users; only the reviewed RPCs reach it.
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.apply_person_interaction_details\(uuid, text\) FROM PUBLIC, anon, authenticated;/);
  assert.doesNotMatch(migration, /GRANT EXECUTE ON FUNCTION public\.apply_person_interaction_details/);
  assert.match(migration, /PERFORM public\.manage_identity_person\(/);
  assert.match(migration, /'person_detail_update_' \|\| v_status/);
  assert.match(migration, /'person_interaction_recorded'/);
  assert.match(migration, /'manual_review_required'/);
  assert.doesNotMatch(migration, /GRANT (?:INSERT|UPDATE|DELETE|ALL) ON (?:TABLE )?public\.person_interactions/i);
});

test('officers record people on their own work; admins add history; privacy holds', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-person-interactions-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const org = '20000000-0000-4000-8000-000000000001';
  const otherOrg = '20000000-0000-4000-8000-000000000002';
  const admin = '20000000-0000-4000-8000-000000000003';
  const officer = '20000000-0000-4000-8000-000000000004';
  const otherOfficer = '20000000-0000-4000-8000-000000000005';
  const site = '20000000-0000-4000-8000-000000000006';
  const job = '20000000-0000-4000-8000-000000000007';
  const closedJob = '20000000-0000-4000-8000-000000000008';
  const shift = '20000000-0000-4000-8000-000000000009';
  const existing = '20000000-0000-4000-8000-00000000000a';
  const zone = '20000000-0000-4000-8000-00000000000b';
  const req1 = '20000000-0000-4000-8000-000000000101';
  const req2 = '20000000-0000-4000-8000-000000000102';
  const req3 = '20000000-0000-4000-8000-000000000103';
  const req4 = '20000000-0000-4000-8000-000000000104';
  const req5 = '20000000-0000-4000-8000-000000000105';
  const req6 = '20000000-0000-4000-8000-000000000106';
  const req7 = '20000000-0000-4000-8000-000000000107';
  const req8 = '20000000-0000-4000-8000-000000000108';
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none', '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');

    const call = (request, fields) => `public.record_person_interaction(p_client_request_id => '${request}', p_organization_id => '${org}', ${fields})`;
    const sql = `
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA auth TO PUBLIC;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $f$;
      CREATE TABLE public.organizations (id uuid PRIMARY KEY, name text);
      CREATE TABLE public.user_profiles (
        id uuid PRIMARY KEY, organization_id uuid, role text, display_name text, deactivated_at timestamptz
      );
      CREATE TABLE public.client_sites (id uuid PRIMARY KEY, name text);
      CREATE TABLE public.location_zones (id uuid PRIMARY KEY, name text);
      CREATE TABLE public.shifts (
        id uuid PRIMARY KEY, organization_id uuid, officer_user_id uuid, location_id uuid, zone_id uuid,
        status text, actual_end timestamptz
      );
      CREATE TABLE public.dispatch_resources (id uuid PRIMARY KEY, assigned_officer_id uuid);
      CREATE TABLE public.dispatch_jobs (
        id uuid PRIMARY KEY, organization_id uuid, job_type text, status text, completed_at timestamptz,
        location_id uuid, client_site_id uuid, zone_id uuid, shift_id uuid, assigned_officer_id uuid, dispatch_resource_id uuid
      );
      CREATE TABLE public.person_records (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, display_name text,
        review_state text NOT NULL DEFAULT 'draft', metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz DEFAULT now()
      );
      CREATE TABLE public.canonical_people (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), canonical_key text UNIQUE, display_name text,
        normalized_name text, metadata jsonb, review_state text, date_of_birth date, updated_at timestamptz
      );
      CREATE TABLE public.canonical_person_links (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), canonical_person_id uuid, source_table text, source_id uuid,
        organization_id uuid, link_kind text, metadata jsonb, UNIQUE (source_table, source_id)
      );
      CREATE TABLE public.evidence_items (id uuid PRIMARY KEY);
      CREATE TABLE public.audit_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, actor_user_id uuid, action text NOT NULL,
        target_table text, target_id uuid, metadata jsonb NOT NULL DEFAULT '{}'
      );
      CREATE TABLE public.person_interactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid REFERENCES public.organizations(id),
        person_id uuid REFERENCES public.canonical_people(id), officer_user_id uuid REFERENCES public.user_profiles(id),
        interaction_type text NOT NULL, notes text, location_id uuid, evidence_id uuid REFERENCES public.evidence_items(id),
        interacted_at timestamptz DEFAULT now(), client_site_id uuid, zone_id uuid, location_event_id uuid,
        CONSTRAINT person_interactions_place_anchor_present_chk CHECK (location_id IS NOT NULL OR client_site_id IS NOT NULL OR zone_id IS NOT NULL)
      );
      ALTER TABLE public.person_interactions ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON public.person_interactions FROM authenticated;
      CREATE FUNCTION public.is_admin_for_org(uuid) RETURNS boolean LANGUAGE sql STABLE AS $f$
        SELECT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND organization_id = $1 AND role = 'admin')
      $f$;
      CREATE FUNCTION public.can_search_people(uuid DEFAULT NULL) RETURNS boolean LANGUAGE sql STABLE AS $f$
        SELECT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND organization_id = $1 AND role IN ('admin', 'admin_officer'))
      $f$;
      ${catalogFunction('normalize_person_name')}
      ${catalogFunction('ensure_canonical_person_for_record')}
      ${catalogFunction('manage_identity_person')}
      CREATE FUNCTION public.assert_ok(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $f$
        BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed: %', label; END IF; END $f$;
      CREATE FUNCTION public.expect_error(statement text, expected text) RETURNS void LANGUAGE plpgsql AS $f$
        DECLARE failed boolean := false;
        BEGIN
          BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN
            IF position(expected IN SQLERRM) = 0 THEN RAISE EXCEPTION 'Unexpected error: %; expected %', SQLERRM, expected; END IF;
            failed := true;
          END;
          IF NOT failed THEN RAISE EXCEPTION 'Expected error: %', expected; END IF;
        END $f$;
      CREATE FUNCTION public.canonical_for(uuid) RETURNS uuid LANGUAGE sql SECURITY DEFINER AS $f$
        SELECT public.ensure_canonical_person_for_record($1)
      $f$;
      CREATE FUNCTION public.record_id_for(text) RETURNS uuid LANGUAGE sql SECURITY DEFINER AS $f$
        SELECT id FROM public.person_records WHERE display_name = $1
      $f$;
      CREATE FUNCTION public.details_of(uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $f$
        SELECT metadata->'profile_details' FROM public.person_records WHERE id = $1
      $f$;
      CREATE FUNCTION public.interaction_for(uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $f$
        BEGIN RETURN (SELECT id FROM public.person_interactions WHERE client_request_id = $1); END
      $f$;
      GRANT EXECUTE ON FUNCTION public.assert_ok(boolean, text), public.expect_error(text, text), public.canonical_for(uuid), public.record_id_for(text),
        public.details_of(uuid), public.interaction_for(uuid) TO authenticated;

      INSERT INTO public.organizations VALUES ('${org}', 'R and M'), ('${otherOrg}', 'Other');
      INSERT INTO public.user_profiles VALUES
        ('${admin}', '${org}', 'admin', 'Admin', NULL),
        ('${officer}', '${org}', 'officer', 'Officer One', NULL),
        ('${otherOfficer}', '${org}', 'officer', 'Officer Two', NULL);
      INSERT INTO public.client_sites VALUES ('${site}', 'Burger N Beast Richmond');
      INSERT INTO public.location_zones VALUES ('${zone}', 'Ward');
      INSERT INTO public.shifts VALUES ('${shift}', '${org}', '${officer}', NULL, '${zone}', 'in_progress', NULL);
      INSERT INTO public.dispatch_jobs VALUES
        ('${job}', '${org}', 'callout', 'on_scene', NULL, NULL, '${site}', NULL, NULL, '${officer}', NULL),
        ('${closedJob}', '${org}', 'callout', 'completed', now() - interval '3 days', NULL, '${site}', NULL, NULL, '${officer}', NULL);
      INSERT INTO public.person_records (id, organization_id, display_name, review_state) VALUES
        ('${existing}', '${org}', 'Known Person', 'verified');

      ${migration}

      SELECT public.assert_ok(NOT has_function_privilege('anon', 'public.record_person_interaction(uuid,uuid,text,text,uuid,text,uuid,uuid,timestamptz,text,jsonb)', 'EXECUTE'), 'anon cannot record');
      SELECT public.assert_ok(NOT has_function_privilege('authenticated', 'public.apply_person_interaction_details(uuid,text)', 'EXECUTE'), 'apply helper is internal');
      SELECT public.assert_ok(NOT has_table_privilege('authenticated', 'public.person_interactions', 'INSERT'), 'no direct table writes');

      SET ROLE authenticated;
      SELECT set_config('request.jwt.claim.sub', '${officer}', false);
      -- An officer names a new person on their own job: a review draft is created, and nothing about matching leaks back.
      SELECT public.assert_ok((SELECT r->>'outcome' = 'recorded' AND NOT r ? 'person_created' AND NOT r ? 'review_state'
        FROM ${call(req1, `p_interaction_type => 'trespass_notice_served', p_notes => 'Asked to leave; trespass notice served.', p_new_person_name => '  Unknown   Male ', p_dispatch_job_id => '${job}'`)} r), 'officer records a new person');
      -- A retry with the same request id returns the same interaction.
      SELECT public.assert_ok((SELECT r->>'outcome' = 'already_recorded' AND NOT r ? 'review_state'
        FROM ${call(req1, `p_interaction_type => 'trespass_notice_served', p_notes => 'Asked to leave; trespass notice served.', p_new_person_name => 'Unknown Male', p_dispatch_job_id => '${job}'`)} r), 'retry is idempotent');
      -- Naming the same person again on the shift links to the one draft instead of creating a second.
      SELECT ${call(req2, `p_interaction_type => 'moved_on', p_notes => 'Moved on from the covered area.', p_new_person_name => 'unknown male', p_shift_id => '${shift}'`)};
      SELECT public.expect_error($q$SELECT ${call(req3, `p_interaction_type => 'spoken_to', p_notes => 'Spoke to them.', p_person_record_id => '${existing}', p_dispatch_job_id => '${job}'`)}$q$,
        'needs person-search access');
      SELECT public.expect_error($q$SELECT ${call(req3, `p_interaction_type => 'spoken_to', p_notes => 'Spoke to them.', p_new_person_name => 'Late Entry', p_dispatch_job_id => '${closedJob}'`)}$q$,
        'This job is closed');
      SELECT public.expect_error($q$SELECT ${call(req3, `p_interaction_type => 'spoken_to', p_notes => 'Spoke to them.', p_new_person_name => 'No Work'`)}$q$,
        'against a dispatch job or shift');
      SELECT public.expect_error($q$SELECT ${call(req3, `p_interaction_type => 'punched', p_notes => 'Spoke to them.', p_new_person_name => 'Bad Type', p_dispatch_job_id => '${job}'`)}$q$,
        'Choose what happened');
      SELECT public.assert_ok(public.get_person_interactions(public.canonical_for((SELECT public.record_id_for('Unknown Male')))) = '[]'::jsonb, 'officer without person search sees no history');
      SELECT set_config('request.jwt.claim.sub', '${otherOfficer}', false);
      SELECT public.expect_error($q$SELECT ${call(req3, `p_interaction_type => 'spoken_to', p_notes => 'Spoke to them.', p_new_person_name => 'Someone', p_dispatch_job_id => '${job}'`)}$q$,
        'Only the officer on this job');
      SELECT public.expect_error($q$SELECT ${call(req1, `p_interaction_type => 'spoken_to', p_notes => 'Replay attempt.', p_new_person_name => 'Someone', p_dispatch_job_id => '${job}'`)}$q$,
        'already used');
      -- Administrators can add after the fact on a closed job, choosing an existing record, and see the outcome.
      SELECT set_config('request.jwt.claim.sub', '${admin}', false);
      SELECT public.assert_ok((SELECT r->>'person_record_id' = '${existing}' AND r->>'review_state' = 'verified'
        FROM ${call(req4, `p_interaction_type => 'report_attached', p_notes => 'Trespass report attached to profile.', p_person_record_id => '${existing}', p_dispatch_job_id => '${closedJob}', p_source => 'admin'`)} r), 'admin records against an existing person');
      SELECT public.assert_ok(jsonb_array_length(public.get_person_interactions(public.canonical_for('${existing}'))) = 1, 'admin reads history');
      SELECT public.assert_ok((SELECT h->>'place_name' = 'Burger N Beast Richmond' AND h->>'officer_name' = 'Officer One'
        FROM jsonb_array_elements(public.get_person_interactions(public.canonical_for('${existing}'))) h), 'history credits the job officer and place');
      SELECT public.assert_ok(jsonb_array_length(public.get_person_interactions(public.canonical_for(public.record_id_for('Unknown Male')))) = 2, 'admin sees the officer-recorded history');

      -- Officers add a new person with identifying details: the draft carries them, and the match outcome stays private.
      SELECT set_config('request.jwt.claim.sub', '${officer}', false);
      SELECT public.assert_ok((SELECT r->>'outcome' = 'recorded' AND NOT r ? 'details_status' AND NOT r ? 'person_created'
        FROM ${call(req5, `p_interaction_type => 'trespass_notice_served', p_notes => 'Trespass notice served at the covered area.', p_new_person_name => 'Grey Hoodie Male', p_dispatch_job_id => '${job}', p_details => '{"description":"Tall, grey hoodie, beard","date_of_birth":"1990-04-12","phone":"021 555 0100","address":"No fixed abode"}'`)} r), 'officer adds a new person with details');
      SELECT public.expect_error($q$SELECT ${call(req8, `p_interaction_type => 'spoken_to', p_notes => 'Spoke to them.', p_new_person_name => 'Someone', p_dispatch_job_id => '${job}', p_details => '{"licence":"X"}'`)}$q$,
        'may only include');
      SELECT public.expect_error($q$SELECT ${call(req8, `p_interaction_type => 'spoken_to', p_notes => 'Spoke to them.', p_new_person_name => 'Someone', p_dispatch_job_id => '${job}', p_details => '{"date_of_birth":"2999-01-01"}'`)}$q$,
        'between 1900 and today');
      -- Officers update a person who already has a record: the details wait for review and never overwrite it directly.
      SELECT public.assert_ok((SELECT r->>'outcome' = 'recorded' AND NOT r ? 'details_status'
        FROM ${call(req6, `p_interaction_type => 'spoken_to', p_notes => 'Spoke with them near the entrance.', p_new_person_name => 'known person', p_dispatch_job_id => '${job}', p_details => '{"phone":"021 555 0101","description":"Red jacket"}'`)} r), 'officer submits details for an existing person');
      SELECT public.assert_ok(public.details_of('${existing}') IS NULL, 'existing record unchanged before review');
      SELECT ${call(req7, `p_interaction_type => 'observed', p_notes => 'Seen at the car park.', p_new_person_name => 'Known Person', p_dispatch_job_id => '${job}', p_details => '{"address":"12 Wrong Street"}'`)};
      SELECT public.assert_ok(public.get_pending_person_detail_updates() = '[]'::jsonb, 'officers cannot see the review queue');
      SELECT public.expect_error($q$SELECT public.review_person_detail_update(public.interaction_for('${req6}'), 'apply', 'Self approval')$q$,
        'Only an administrator');

      SELECT set_config('request.jwt.claim.sub', '${admin}', false);
      SELECT public.assert_ok((SELECT jsonb_array_length(q) = 2 AND q->0->>'person_name' = 'Known Person' AND q->0->'proposed_details'->>'phone' = '021 555 0101'
        FROM public.get_pending_person_detail_updates() q), 'admin sees pending details oldest first');
      SELECT public.expect_error($q$SELECT public.review_person_detail_update(public.interaction_for('${req6}'), 'apply', '')$q$, 'A reason is required');
      SELECT public.assert_ok((public.review_person_detail_update(public.interaction_for('${req6}'), 'apply', 'Confirmed with the officer'))->>'proposal_status' = 'applied', 'admin applies details');
      SELECT public.assert_ok((SELECT d->>'phone' = '021 555 0101' AND d->>'notes' = 'Red jacket' FROM public.details_of('${existing}') d), 'applied details reach the person record');
      SELECT public.expect_error($q$SELECT public.review_person_detail_update(public.interaction_for('${req6}'), 'dismiss', 'Second look')$q$, 'already been reviewed');
      SELECT public.assert_ok((public.review_person_detail_update(public.interaction_for('${req7}'), 'dismiss', 'Address not verified'))->>'proposal_status' = 'dismissed', 'admin dismisses details');
      SELECT public.assert_ok(NOT (public.details_of('${existing}') ? 'address'), 'dismissed details are not applied');
      -- Administrators' own details apply immediately through the registry path.
      SELECT public.assert_ok((SELECT r->>'details_status' = 'applied'
        FROM ${call(req8, `p_interaction_type => 'spoken_to', p_notes => 'Confirmed date of birth.', p_person_record_id => '${existing}', p_dispatch_job_id => '${job}', p_source => 'admin', p_details => '{"date_of_birth":"1985-02-03"}'`)} r), 'admin details apply directly');
      SELECT public.assert_ok((SELECT d->>'date_of_birth' = '1985-02-03' AND d->>'phone' = '021 555 0101' FROM public.details_of('${existing}') d), 'admin update merges with earlier details');
      SELECT public.assert_ok(public.get_pending_person_detail_updates() = '[]'::jsonb, 'queue is empty after review');
      SELECT public.assert_ok((SELECT count(*) = 1 FROM jsonb_array_elements(public.get_person_interactions(public.canonical_for('${existing}'))) h
        WHERE h->>'proposal_status' = 'dismissed' AND h->'proposed_details'->>'address' = '12 Wrong Street'), 'admin history shows the review outcome');
      RESET ROLE;

      SELECT public.assert_ok((SELECT count(*) = 1 FROM public.person_records WHERE display_name = 'Unknown Male'
        AND review_state = 'manual_review_required' AND metadata->>'created_from' = 'person_interaction'), 'one draft person');
      SELECT public.assert_ok((SELECT count(*) = 2 FROM public.person_interactions pi JOIN public.person_records pr ON pr.id = pi.person_record_id
        WHERE pr.display_name = 'Unknown Male' AND pi.person_id IS NOT NULL), 'both interactions link the draft and its canonical identity');
      SELECT public.assert_ok((SELECT zone_id = '${zone}' AND shift_id = '${shift}' FROM public.person_interactions WHERE client_request_id = '${req2}'), 'shift interaction anchored to the shift place');
      SELECT public.assert_ok((SELECT count(*) = 7 FROM public.audit_log WHERE action = 'person_interaction_recorded'), 'each write is audited');
      SELECT public.assert_ok((SELECT count(*) = 1 FROM public.audit_log WHERE action = 'person_detail_update_applied')
        AND (SELECT count(*) = 1 FROM public.audit_log WHERE action = 'person_detail_update_dismissed')
        AND (SELECT count(*) = 2 FROM public.audit_log WHERE action = 'identity_person_update'), 'reviews and registry updates are audited');
      SELECT public.assert_ok((SELECT d->>'notes' = 'Tall, grey hoodie, beard' AND d->>'date_of_birth' = '1990-04-12' AND d->>'phone' = '021 555 0100'
        FROM public.person_records pr, LATERAL (SELECT pr.metadata->'profile_details' AS d) x
        WHERE pr.display_name = 'Grey Hoodie Male' AND pr.review_state = 'manual_review_required'), 'new draft carries officer details');
      SELECT public.assert_ok((SELECT proposal_status = 'applied_to_draft' FROM public.person_interactions WHERE client_request_id = '${req5}'), 'draft details marked applied_to_draft');
      SELECT public.assert_ok((SELECT officer_user_id = '${officer}' AND created_by = '${admin}' FROM public.person_interactions WHERE client_request_id = '${req4}'), 'admin entry credits the officer');
    `;
    docker(['exec', '-i', name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], sql);
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});
