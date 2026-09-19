const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260919030000_roster_shift_operating_branch.sql'), 'utf8');
const schema = fs.readFileSync(path.resolve(__dirname, '../supabase/schema.sql'), 'utf8');

test('the old nine-argument overload is dropped so nine-argument calls stay unambiguous', () => {
  assert.match(migration, /drop function if exists public\.create_roster_shift\(uuid, text, timestamp with time zone, timestamp with time zone, uuid, uuid, uuid, text, boolean\);/);
  assert.match(migration, /p_publish boolean default false,\n\s+p_organization_id uuid default null\n\) returns public\.shifts/);
  const overloads = schema.match(/CREATE OR REPLACE FUNCTION "public"\."create_roster_shift"\(/g) ?? [];
  assert.equal(overloads.length, 1, 'live schema must expose exactly one create_roster_shift');
  assert.match(schema, /"create_roster_shift"\(p_officer_user_id uuid,[^\n]*p_publish boolean DEFAULT false, p_organization_id uuid DEFAULT NULL::uuid\)/);
});

test('authority and eligibility are judged at the operating organisation, defaulting to the officer home organisation', () => {
  assert.match(migration, /v_org := coalesce\(p_organization_id, v_profile\.organization_id\);/);
  assert.match(migration, /if not public\.is_admin_for_org\(v_org\) then raise exception 'Not authorised to roster for this organisation'/);
  assert.match(migration, /if v_org <> v_profile\.organization_id and not exists \(\n\s+select 1 from public\.staff_branch_authorisations a\n\s+where a\.user_id = p_officer_user_id\n\s+and a\.branch_org_id = v_org\n\s+and a\.status = 'active'\n\s+and a\.can_be_rostered/);
  assert.match(migration, /raise exception 'Officer is not authorised to be rostered at this branch'/);
});

test('the staff profile is found through the employer, not only the home organisation', () => {
  assert.match(migration, /or s\.organization_id = v_profile\.employer_organization_id\n\s+or v_org = any\(public\.get_descendant_organizations\(s\.organization_id\)\)/);
  assert.match(migration, /if not found or not v_staff\.work_ready then raise exception 'Officer is not work ready'/);
});

test('the shift and its audit row are stamped with the operating organisation, and the caller hands the slot branch down', () => {
  assert.match(migration, /insert into public\.shifts\(organization_id, [^\n]*\n\s+values \(v_org, p_officer_user_id/);
  assert.match(migration, /values \(v_org, v_actor, 'roster_shift_created', 'shifts', v_shift\.id, jsonb_build_object\(\n\s+'officer_user_id', p_officer_user_id,\n\s+'officer_home_organization_id', v_profile\.organization_id/);
  const handoffs = migration.match(/public\.create_roster_shift\(v_user,[^\n]*,true,v_slot\.organization_id\)/g) ?? [];
  assert.equal(handoffs.length, 2, 'both patrol and static materialisation pass the slot branch');
  assert.doesNotMatch(migration, /UPDATE public\.shifts SET organization_id=v_slot\.organization_id/);
});

test('leave, overlap, timing and publish semantics are unchanged', () => {
  assert.match(migration, /l\.status = 'approved'/);
  assert.match(migration, /s\.scheduled_start < p_scheduled_end\n\s+and s\.scheduled_end > p_scheduled_start/);
  assert.match(migration, /interval '24 hours'/);
  assert.match(migration, /case when p_publish then 'published' else 'scheduled' end/);
});

test('historical audit rows are re-homed to the shift organisation with provenance, never deleted', () => {
  assert.match(migration, /update public\.audit_log a\n\s+set organization_id = s\.organization_id,\n\s+metadata = a\.metadata \|\| jsonb_build_object\('rehomed_from_organization_id', a\.organization_id/);
  assert.match(migration, /where a\.target_table = 'shifts' and a\.action = 'roster_shift_created' and a\.target_id = s\.id and a\.organization_id <> s\.organization_id/);
  assert.doesNotMatch(migration, /delete from public\.audit_log/i);
});
