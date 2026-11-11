'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261112100000_verify_staff_credential.sql'), 'utf8');
const profilePage = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/StaffProfilePage.tsx'), 'utf8');

test('verifying an existing credential is admin-only, evidence-backed, replay-safe and audited', () => {
  const sql = migration.replace(/\s+/g, ' ');
  assert.match(sql, /if not public\.is_admin_for_org\(v_row\.organization_id\) then raise exception 'Active provider administrator required'/);
  assert.match(sql, /if v_number is null or v_authority is null or v_notes is null or length\(v_notes\) < 10 then/);
  assert.match(sql, /if v_row\.verified then raise exception 'This credential is already verified'/);
  assert.match(sql, /'staff_credential_verified', 'staff_credentials', v_row\.id/);
  assert.match(sql, /revoke all on function public\.verify_staff_credential\(uuid, uuid, text, text, date, date, text\) from public, anon, authenticated, service_role;/);
  assert.match(sql, /grant execute on function public\.verify_staff_credential\(uuid, uuid, text, text, date, date, text\) to postgres, authenticated;/);
});

test('the credential record panel offers Verify credential to administrators through the RPC', () => {
  assert.match(profilePage, /supabase\.rpc\('verify_staff_credential', \{/);
  assert.match(profilePage, /recordKind === 'credential' && canManagePay && selectedRecord && !selectedRecord\.verified/);
  assert.doesNotMatch(profilePage, /from\('staff_credentials'\)\.(insert|upsert|update)/);
});

test('verify_staff_credential runs in disposable PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async () => {
  const name = `fcm-verify-credential-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const sql = (input) => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], input);
  const fails = (input, pattern) => assert.throws(() => sql(input), (error) => pattern.test(String(error.stderr ?? error.message)));
  const org = '00000000-0000-4000-8000-000000000001';
  const admin = '00000000-0000-4000-8000-000000000002';
  const outsider = '00000000-0000-4000-8000-000000000003';
  const credential = '00000000-0000-4000-8000-000000000004';
  const request = '00000000-0000-4000-8000-000000000005';
  const verify = (actor, req, { number = '25-127518', authority = 'Private Security Personnel Licensing Authority', issued = 'NULL', expiry = 'NULL', notes = 'COA checked against the PSPLA public register' } = {}) =>
    `BEGIN; SET LOCAL request.jwt.claim.sub='${actor}'; SELECT row_to_json(r) FROM public.verify_staff_credential('${req}','${credential}','${number}','${authority}',${issued},${expiry},'${notes}') r; COMMIT;`;
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17']);
    created = true;
    for (let attempt = 0; attempt < 120; attempt++) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    sql(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      CREATE TABLE public.staff_credentials(id uuid PRIMARY KEY, staff_id uuid NOT NULL, organization_id uuid NOT NULL,
        credential_type text NOT NULL, credential_number text, issuing_authority text, issued_date date, expiry_date date,
        verified boolean NOT NULL DEFAULT false, verified_by uuid, verified_at timestamptz, notes text);
      CREATE TABLE public.audit_log(id bigserial, organization_id uuid, actor_user_id uuid, action text NOT NULL,
        target_table text, target_id uuid, metadata jsonb NOT NULL DEFAULT '{}');
      CREATE FUNCTION public.is_admin_for_org(p_org uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT auth.uid()='${admin}' AND p_org='${org}'
      $$;
      INSERT INTO public.staff_credentials(id, staff_id, organization_id, credential_type, credential_number, issuing_authority, expiry_date, notes)
        VALUES ('${credential}', gen_random_uuid(), '${org}', 'certificate_of_authority', '25-127518',
          'Private Security Personnel Licensing Authority', '2030-05-19', 'Imported as unverified evidence from Staff COA Sheet.');
    `);
    sql(migration);

    fails(verify(outsider, randomUUID()), /Active provider administrator required/);
    fails(verify(admin, randomUUID(), { notes: 'short' }), /evidence notes of at least 10 characters/);
    fails(verify(admin, randomUUID(), { authority: '' }), /evidence notes of at least 10 characters/);
    fails(verify(admin, randomUUID(), { issued: "'2031-01-01'" }), /expiry cannot precede its issue date/);

    const first = JSON.parse(sql(verify(admin, request, { issued: "'2025-05-19'" })).trim());
    assert.equal(first.verified, true);
    assert.equal(first.replayed, false);
    const row = sql(`SELECT verified_by || '|' || issued_date || '|' || expiry_date || '|' || notes FROM public.staff_credentials WHERE id='${credential}'`).trim();
    assert.match(row, new RegExp(`^${admin}\\|2025-05-19\\|2030-05-19\\|Imported as unverified evidence from Staff COA Sheet\\.\\nVerified \\d{2} \\w{3} \\d{4}: COA checked against the PSPLA public register$`));

    const replay = JSON.parse(sql(verify(admin, request)).trim());
    assert.equal(replay.replayed, true);
    fails(verify(admin, randomUUID()), /already verified/);
    assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE action='staff_credential_verified' AND target_id='${credential}'`).trim(), '1');
    assert.equal(sql(`SELECT has_function_privilege('anon','public.verify_staff_credential(uuid,uuid,text,text,date,date,text)','EXECUTE')`).trim(), 'f');
    assert.equal(sql(`SELECT has_function_privilege('authenticated','public.verify_staff_credential(uuid,uuid,text,text,date,date,text)','EXECUTE')`).trim(), 't');
  } finally {
    if (created) {
      try { docker(['rm', '--force', name]); } catch { /* best effort */ }
    }
  }
});
