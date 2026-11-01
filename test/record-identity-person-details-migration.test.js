'use strict';
// record_identity_person_details is the one audited database operation behind in-app Bob's confirmed person steps
// (PR #284 review): create is serialised per organisation and name and returns the person instead of a duplicate;
// update changes details only, never the name, and refuses merged records. The helpers it calls are loaded from the
// live schema snapshot, so the test exercises the real manage_identity_person. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261102110000_record_identity_person_details.sql'), 'utf8');
const schema = fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8');
const SIGNATURE = 'public.record_identity_person_details(uuid, uuid, text, jsonb, uuid[], text)';

function liveFunction(name) {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  assert.ok(start >= 0, `${name} is in the schema snapshot`);
  const end = schema.indexOf('$function$;', start);
  return schema.slice(start, end + '$function$;'.length);
}

test('the migration is an administrator-only definer function that never sends the name on update', () => {
  assert.match(migration, /SECURITY DEFINER\n SET search_path TO 'public'/);
  assert.match(migration, /RAISE EXCEPTION 'Identity registry administrator access required' USING ERRCODE = '42501'/);
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\('identity_person_create:' \|\| p_organization_id::text \|\| ':' \|\| v_norm, 0\)\)/);
  assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION ${SIGNATURE.replace(/[()[\]]/g, '\\$&')} FROM PUBLIC, anon, authenticated, service_role;`));
  assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION ${SIGNATURE.replace(/[()[\]]/g, '\\$&')} TO authenticated;`));
  const update = migration.slice(migration.indexOf("IF v_details = '{}'::jsonb"), migration.indexOf('END;\n$function$;'));
  assert.doesNotMatch(update, /display_name\s*=/);
  assert.doesNotMatch(update, /manage_identity_person/);
  assert.doesNotMatch(migration, /\bDROP\b/);
});

test('person create and update behave as confirmed, against disposable PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-person-details-${randomUUID()}`;
  const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const psqlArgs = ['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'];
  const psql = (sql) => execFileSync('docker', psqlArgs, { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const psqlLater = (sql) => new Promise((resolve, reject) => {
    const child = spawn('docker', psqlArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `psql exited ${code}`))));
    child.stdin.end(sql);
  });
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
    const member = 'a0000000-0000-4000-8000-000000000002';
    const as = (user) => `SELECT set_config('request.jwt.claim.sub', '${user}', false);`;
    const rpc = (org, action, fields, { person = null, distinct = [], reason = 'Bob chat (confirmed by user): synthetic test' } = {}) =>
      `public.record_identity_person_details('${org}', ${person ? `${person}` : 'NULL'}, '${action}', '${JSON.stringify(fields).replace(/'/g, "''")}'::jsonb, ` +
      `ARRAY[${distinct.join(',')}]::uuid[], '${reason}')`;
    const id = (key) => `(SELECT v FROM ids WHERE k = '${key}')`;

    psql(`
      DO $$ BEGIN
        CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN; CREATE ROLE stranger NOLOGIN;
      END $$;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $fn$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;
      CREATE FUNCTION public.is_admin_for_org(p_organization_id uuid) RETURNS boolean LANGUAGE sql STABLE AS
        $fn$ SELECT auth.uid() = '${admin}'::uuid $fn$;
      CREATE TABLE public.person_records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, display_name text,
        review_state text NOT NULL DEFAULT 'draft', metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE public.person_record_aliases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
        person_record_id uuid NOT NULL, alias text NOT NULL, active boolean NOT NULL DEFAULT true);
      CREATE TABLE public.canonical_people (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), canonical_key text NOT NULL UNIQUE, display_name text,
        normalized_name text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, review_state text NOT NULL DEFAULT 'draft',
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), date_of_birth date);
      CREATE TABLE public.canonical_person_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), canonical_person_id uuid NOT NULL,
        source_table text NOT NULL, source_id uuid NOT NULL, organization_id uuid, link_kind text NOT NULL DEFAULT 'projection',
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb, UNIQUE (source_table, source_id));
      CREATE TABLE public.audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, actor_user_id uuid, action text NOT NULL,
        target_table text, target_id uuid, metadata jsonb NOT NULL DEFAULT '{}'::jsonb);
      ${liveFunction('normalize_person_name')}
      ${liveFunction('ensure_canonical_person_for_record')}
      ${liveFunction('manage_identity_person')}
      ${migration}
    `);

    // Two confirmations of the same new person at once: the second waits on the per-name lock, then finds the first.
    const slow = psqlLater(`${as(admin)} BEGIN; SELECT ${rpc(orgA, 'create', { display_name: 'Casey Race' })}->>'outcome'; SELECT pg_sleep(1.5); COMMIT;`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const second = psql(`${as(admin)} SELECT ${rpc(orgA, 'create', { display_name: 'casey  RACE' })}->>'outcome';`);
    const first = await slow;
    assert.match(first, /^created$/m);
    assert.match(second, /^existing$/m);
    assert.equal(psql("SELECT count(*) FROM public.person_records WHERE display_name ILIKE 'casey%race';").trim(), '1');

    psql(`
      CREATE FUNCTION pg_temp.check(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $fn$
      BEGIN IF NOT coalesce(ok, false) THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $fn$;
      CREATE FUNCTION pg_temp.raises(stmt text, pattern text, label text, code text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $fn$
      BEGIN
        BEGIN
          EXECUTE stmt;
        EXCEPTION WHEN OTHERS THEN
          IF SQLERRM ~ pattern AND (code IS NULL OR SQLSTATE = code) THEN RETURN; END IF;
          RAISE EXCEPTION 'FAIL: % (raised % %)', label, SQLSTATE, SQLERRM;
        END;
        RAISE EXCEPTION 'FAIL: % (did not raise)', label;
      END $fn$;
      CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
      CREATE TEMP TABLE results (k text PRIMARY KEY, v jsonb);
      ${as(admin)}

      -- create: a new person, with only the chat details kept.
      INSERT INTO results SELECT 'riley', ${rpc(orgA, 'create', { display_name: '  Riley   Sample ', category: 'Compliance officer', phone: '021 000 0000', driver_licence_number: 'XX123' })};
      INSERT INTO ids SELECT 'riley', (v->>'person_record_id')::uuid FROM results WHERE k = 'riley';
      SELECT pg_temp.check((SELECT v->>'outcome' FROM results WHERE k = 'riley') = 'created', 'a new person is created');
      SELECT pg_temp.check((SELECT display_name FROM public.person_records WHERE id = ${id('riley')}) = 'Riley Sample', 'the name is tidied');
      SELECT pg_temp.check((SELECT metadata->'profile_details' FROM public.person_records WHERE id = ${id('riley')})
        = '{"category": "Compliance officer", "phone": "021 000 0000"}'::jsonb, 'only chat details are kept');
      SELECT pg_temp.check((SELECT review_state FROM public.person_records WHERE id = ${id('riley')}) = 'manual_review_required', 'a chat-created person awaits review');
      SELECT pg_temp.check((SELECT count(*) FROM public.audit_log WHERE action = 'identity_person_create' AND target_id = ${id('riley')}
        AND metadata->>'reason' = 'Bob chat (confirmed by user): synthetic test') = 1, 'the create is audited with the reason');

      -- create again: the same person (any spacing or case) is returned, not duplicated, and nothing is written.
      INSERT INTO results SELECT 'riley-again', ${rpc(orgA, 'create', { display_name: 'riley sample', category: 'Changed' })};
      SELECT pg_temp.check((SELECT v->>'outcome' FROM results WHERE k = 'riley-again') = 'existing', 'an existing person is returned');
      SELECT pg_temp.check((SELECT (v->>'person_record_id')::uuid FROM results WHERE k = 'riley-again') = ${id('riley')}, 'the same record id is returned');
      SELECT pg_temp.check((SELECT (v->>'canonical_person_id') IS NOT NULL FROM results WHERE k = 'riley-again'), 'its platform identity is returned');
      SELECT pg_temp.check((SELECT metadata->'profile_details'->>'category' FROM public.person_records WHERE id = ${id('riley')}) = 'Compliance officer', 'the existing details are untouched');
      -- The user said this is a different person: a second record is made, and then the name alone is ambiguous.
      INSERT INTO results SELECT 'riley-two', ${rpc(orgA, 'create', { display_name: 'Riley Sample' }, { distinct: [id('riley')] })};
      SELECT pg_temp.check((SELECT v->>'outcome' FROM results WHERE k = 'riley-two') = 'created', 'a confirmed different person is created');
      SELECT pg_temp.raises($q$SELECT ${rpc(orgA, 'create', { display_name: 'Riley Sample' })}$q$, '^AMBIGUOUS_PERSON: 2 people named Riley Sample', 'two namesakes are ambiguous');
      -- Another organisation's person never counts.
      INSERT INTO results SELECT 'riley-b', ${rpc(orgB, 'create', { display_name: 'Riley Sample' })};
      SELECT pg_temp.check((SELECT v->>'outcome' FROM results WHERE k = 'riley-b') = 'created', 'another organisation keeps its own register');

      -- Dates of birth: a different one is a different person; the platform identity's date counts when the profile has none.
      INSERT INTO results SELECT 'alex', ${rpc(orgA, 'create', { display_name: 'Alex Example', date_of_birth: '1990-01-01' })};
      INSERT INTO results SELECT 'alex-other', ${rpc(orgA, 'create', { display_name: 'Alex Example', date_of_birth: '1985-05-05' })};
      INSERT INTO results SELECT 'alex-same', ${rpc(orgA, 'create', { display_name: 'Alex Example', date_of_birth: '1990-01-01' })};
      SELECT pg_temp.check((SELECT v->>'outcome' FROM results WHERE k = 'alex-other') = 'created', 'a different date of birth is a different person');
      SELECT pg_temp.check((SELECT v->>'outcome' FROM results WHERE k = 'alex-same') = 'existing', 'the same date of birth is the same person');
      SELECT pg_temp.check((SELECT v->'person_record_id' FROM results WHERE k = 'alex-same') = (SELECT v->'person_record_id' FROM results WHERE k = 'alex'), 'it is the first record');
      INSERT INTO public.person_records (organization_id, display_name) VALUES ('${orgA}', 'Sam Canon');
      INSERT INTO ids SELECT 'sam', id FROM public.person_records WHERE display_name = 'Sam Canon';
      SELECT public.ensure_canonical_person_for_record(${id('sam')});
      UPDATE public.canonical_people SET date_of_birth = '1970-01-01' WHERE canonical_key = 'person_record:' || ${id('sam')}::text;
      INSERT INTO results SELECT 'sam-other', ${rpc(orgA, 'create', { display_name: 'Sam Canon', date_of_birth: '1980-02-02' })};
      SELECT pg_temp.check((SELECT v->>'outcome' FROM results WHERE k = 'sam-other') = 'created', 'the platform identity date of birth separates namesakes');

      -- An active alias is the person; a retired alias and a merged record are not.
      INSERT INTO public.person_records (organization_id, display_name) VALUES ('${orgA}', 'Pat Original');
      INSERT INTO ids SELECT 'pat', id FROM public.person_records WHERE display_name = 'Pat Original';
      INSERT INTO public.person_record_aliases (organization_id, person_record_id, alias, active) VALUES
        ('${orgA}', ${id('pat')}, 'Pat Alias', true), ('${orgA}', ${id('pat')}, 'Pat Retired', false);
      INSERT INTO results SELECT 'pat-alias', ${rpc(orgA, 'create', { display_name: 'Pat Alias' })};
      SELECT pg_temp.check((SELECT (v->>'person_record_id')::uuid FROM results WHERE k = 'pat-alias') = ${id('pat')}, 'an active alias finds the person');
      INSERT INTO results SELECT 'pat-retired', ${rpc(orgA, 'create', { display_name: 'Pat Retired' })};
      SELECT pg_temp.check((SELECT v->>'outcome' FROM results WHERE k = 'pat-retired') = 'created', 'a retired alias does not');
      INSERT INTO public.person_records (organization_id, display_name, metadata) VALUES
        ('${orgA}', 'Morgan Merged', jsonb_build_object('merged_into_person_record_id', ${id('pat')}));
      INSERT INTO ids SELECT 'morgan', id FROM public.person_records WHERE display_name = 'Morgan Merged';
      INSERT INTO results SELECT 'morgan-new', ${rpc(orgA, 'create', { display_name: 'Morgan Merged' })};
      SELECT pg_temp.check((SELECT v->>'outcome' FROM results WHERE k = 'morgan-new') = 'created', 'a merged record is never returned');

      -- update: details only, under the lock; a rename made since the preview stands.
      UPDATE public.person_records SET display_name = 'Riley Renamed' WHERE id = ${id('riley')};
      INSERT INTO results SELECT 'riley-update', ${rpc(orgA, 'update', { display_name: 'Riley Sample', email: 'riley@example.test' }, { person: id('riley') })};
      SELECT pg_temp.check((SELECT v->>'outcome' FROM results WHERE k = 'riley-update') = 'updated', 'new details are added');
      SELECT pg_temp.check((SELECT display_name FROM public.person_records WHERE id = ${id('riley')}) = 'Riley Renamed', 'the rename stands');
      SELECT pg_temp.check((SELECT metadata->'profile_details' FROM public.person_records WHERE id = ${id('riley')})
        = '{"category": "Compliance officer", "phone": "021 000 0000", "email": "riley@example.test"}'::jsonb, 'details merge');
      SELECT pg_temp.check((SELECT metadata->'fields' FROM public.audit_log WHERE action = 'identity_person_details_update' AND target_id = ${id('riley')})
        = '["email"]'::jsonb, 'the update is audited with the fields it changed');
      SELECT pg_temp.check((SELECT count(*) FROM public.audit_log WHERE action = 'identity_person_update') = 0, 'manage_identity_person update is never used');
      INSERT INTO results SELECT 'riley-same', ${rpc(orgA, 'update', { email: 'riley@example.test', phone: '021 000 0000' }, { person: id('riley') })};
      SELECT pg_temp.check((SELECT v->>'outcome' FROM results WHERE k = 'riley-same') = 'unchanged', 'details already held change nothing');
      SELECT pg_temp.check((SELECT count(*) FROM public.audit_log WHERE action = 'identity_person_details_update') = 1, 'and are not audited as a change');
      -- A date of birth reaches the platform identity only while no other organisation shares it.
      INSERT INTO results SELECT 'riley-dob', ${rpc(orgA, 'update', { date_of_birth: '1991-03-04' }, { person: id('riley') })};
      SELECT pg_temp.check((SELECT date_of_birth FROM public.canonical_people WHERE id = (SELECT (v->>'canonical_person_id')::uuid FROM results WHERE k = 'riley-dob')) = '1991-03-04', 'an unshared identity takes the date of birth');
      INSERT INTO public.canonical_person_links (canonical_person_id, source_table, source_id, organization_id)
        SELECT (v->>'canonical_person_id')::uuid, 'staff_profiles', gen_random_uuid(), '${orgB}' FROM results WHERE k = 'riley-dob';
      SELECT ${rpc(orgA, 'update', { date_of_birth: '1992-05-06' }, { person: id('riley') })};
      SELECT pg_temp.check((SELECT date_of_birth FROM public.canonical_people WHERE id = (SELECT (v->>'canonical_person_id')::uuid FROM results WHERE k = 'riley-dob')) = '1991-03-04', 'a shared identity keeps its date of birth');
      SELECT pg_temp.check((SELECT metadata->'profile_details'->>'date_of_birth' FROM public.person_records WHERE id = ${id('riley')}) = '1992-05-06', 'the organisation profile records it');

      -- Refusals.
      SELECT pg_temp.raises($q$SELECT ${rpc(orgA, 'update', { notes: 'Seen' }, { person: id('morgan') })}$q$, 'merged into another record', 'a merged person is refused');
      SELECT pg_temp.raises($q$SELECT ${rpc(orgB, 'update', { notes: 'Seen' }, { person: id('riley') })}$q$, 'Person record not found in this organization', 'another organisation''s person is not found');
      SELECT pg_temp.raises($q$SELECT ${rpc(orgA, 'update', { display_name: 'Only A Name' }, { person: id('riley') })}$q$, 'No person details were given', 'a name alone is not a details update');
      SELECT pg_temp.raises($q$SELECT ${rpc(orgA, 'create', { display_name: ' - ' })}$q$, 'Person name is required', 'a name is required');
      SELECT pg_temp.raises($q$SELECT ${rpc(orgA, 'create', { display_name: 'N'.repeat(121) })}$q$, 'longer than the register allows', 'a long name is refused');
      SELECT pg_temp.raises($q$SELECT ${rpc(orgA, 'create', { display_name: 'Future Person', date_of_birth: '2999-01-01' })}$q$, 'cannot be in the future', 'a future date of birth is refused');
      SELECT pg_temp.raises($q$SELECT ${rpc(orgA, 'create', { display_name: 'Long Category', category: 'c'.repeat(121) })}$q$, 'longer than the register allows', 'a long detail is refused');
      SELECT pg_temp.raises($q$SELECT ${rpc(orgA, 'create', { display_name: 'No Reason' }, { reason: ' ' })}$q$, 'A reason is required', 'a reason is required');
      SELECT pg_temp.raises($q$SELECT ${rpc(orgA, 'retire_faces', {}, { person: id('riley') })}$q$, 'Unsupported person action', 'only create and update are offered');
      ${as(member)}
      SELECT pg_temp.raises($q$SELECT ${rpc(orgA, 'create', { display_name: 'Member Made' })}$q$, 'administrator access required', 'a member is refused', '42501');
      SELECT set_config('request.jwt.claim.sub', '', false);
      SELECT pg_temp.raises($q$SELECT ${rpc(orgA, 'update', { notes: 'x' }, { person: id('riley') })}$q$, 'administrator access required', 'an anonymous caller is refused', '42501');
      SELECT pg_temp.check((SELECT count(*) FROM public.person_records WHERE display_name = 'Member Made') = 0, 'nothing was created for them');

      SELECT pg_temp.check(has_function_privilege('authenticated', '${SIGNATURE}', 'EXECUTE'), 'signed-in users may call it');
      SELECT pg_temp.check(NOT has_function_privilege('anon', '${SIGNATURE}', 'EXECUTE'), 'anonymous callers may not');
      SELECT pg_temp.check(NOT has_function_privilege('service_role', '${SIGNATURE}', 'EXECUTE'), 'the service role may not');
      SELECT pg_temp.check(NOT has_function_privilege('stranger', '${SIGNATURE}', 'EXECUTE'), 'PUBLIC may not');
      SELECT pg_temp.check(obj_description('${SIGNATURE}'::regprocedure, 'pg_proc') LIKE 'Administrator person step for confirmed chat updates.%', 'the function is documented');
    `);
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});
