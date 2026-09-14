const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260914120000_noise_direction_particulars.sql'), 'utf8');
const oracle = fs.readFileSync(path.join(root, 'supabase/tests/20260914110000_noise_two_place_rls.sql'), 'utf8');
const twoPlace = fs.readFileSync(path.join(root, 'supabase/migrations/20260914110000_noise_two_place_attendance_model.sql'), 'utf8');

const signature = 'record_noise_direction_particulars(uuid, uuid, boolean, text, smallint, boolean)';

test('the command is a single additive governed RPC: no table, policy or other writer changes', () => {
  assert.equal((migration.match(/CREATE OR REPLACE FUNCTION/g) || []).length, 1);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.record_noise_direction_particulars\(/);
  assert.doesNotMatch(migration, /CREATE TABLE|ALTER TABLE|CREATE POLICY|DROP POLICY|DROP TABLE|DROP COLUMN|CREATE TRIGGER/);
  assert.match(migration, /LANGUAGE plpgsql SECURITY DEFINER SET search_path = public/);
  assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature.replace(/[()]/g, '\\$&')} FROM PUBLIC, anon;`));
  assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature.replace(/[()]/g, '\\$&')} TO authenticated, service_role;`));
  assert.match(migration, /COMMENT ON FUNCTION public\.record_noise_direction_particulars/);
});

test('only the columns the two-place model created are written, and only on the officer organisation row', () => {
  const update = migration.slice(migration.indexOf('UPDATE public.noise_assessments'), migration.indexOf('RETURNING * INTO v_assessment'));
  const written = [...update.matchAll(/^\s+(?:SET )?(\w+) = /gm)].map((m) => m[1]).sort();
  assert.deepEqual(written, ['end_expires_at', 'end_given_orally', 'end_recipient_role', 'entry_notice_left']);
  for (const column of written) assert.match(twoPlace, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`), `${column} must come from 20260914110000`);
  assert.match(migration, /WHERE na\.id = p_assessment_id AND na\.organization_id = v_org/);
  assert.match(migration, /v_assessment\.officer_user_id = v_user OR public\.is_admin_for_org\(v_org\)/);
  assert.match(migration, /action_taken NOT IN \('direction_notice', 'equipment_seized'\)/);
});

test('statutory rules are enforced in the command, not left to the client', () => {
  // s327(2) oral or written; s328(5) unoccupied entry leaves a written direction and entry notice.
  assert.match(migration, /p_recipient_role NOT IN \('occupier', 'responsible_person', 'unoccupied_notice_left'\)/);
  assert.match(migration, /p_recipient_role = 'unoccupied_notice_left' AND NOT coalesce\(p_entry_notice_left, false\)[\s\S]*?RMA s328\(5\)/);
  assert.match(migration, /p_recipient_role = 'unoccupied_notice_left' AND coalesce\(p_given_orally, false\)[\s\S]*?must be written \(RMA s328\(5\)\(a\)\)/);
  // s327(3) 8 days or a shorter officer-specified period, never beyond the council rule (itself capped at 192 h by 20260914110000).
  assert.match(migration, /v_cap smallint := 192/);
  assert.match(migration, /SELECT n\.end_validity_hours INTO v_cap FROM public\.noise_module_config n/);
  assert.match(migration, /p_period_hours < 1 OR p_period_hours > v_cap/);
  assert.match(migration, /Direction period must be between 1 and % hours \(RMA s327\(3\); council rule\)/);
  assert.match(migration, /assessed_at \+ make_interval\(hours => p_period_hours\)/);
  assert.match(twoPlace, /ADD COLUMN IF NOT EXISTS end_validity_hours smallint NOT NULL DEFAULT 192;/);
  assert.match(twoPlace, /CHECK \(end_validity_hours BETWEEN 1 AND 192\)/);
});

test('idempotency receipt is actor-bound and the write is audited', () => {
  assert.match(migration, /WHERE r\.request_id = p_client_request_id::text/);
  assert.match(migration, /v_receipt\.actor_user_id IS DISTINCT FROM v_user THEN RAISE EXCEPTION 'client_request_id belongs to another actor'/);
  assert.match(migration, /v_receipt\.command_status = 'completed' THEN\s+RETURN QUERY/);
  assert.match(migration, /INSERT INTO public\.officer_command_requests[\s\S]*?'record_noise_direction_particulars', 'completed'/);
  assert.match(migration, /ON CONFLICT \(request_id\) DO UPDATE SET command_status = 'completed', response = EXCLUDED\.response/);
  assert.match(migration, /INSERT INTO public\.audit_log[\s\S]*?'noise_direction_particulars_recorded', 'noise_assessments', v_assessment\.id/);
});

test('the disposable-database truth table exercises every rule the command claims', () => {
  for (const label of [
    'direction particulars receipt returned',
    'written direction to the occupier recorded',
    'expiry is assessed_at + 48 h after the officer specified 48 h',
    'a period beyond the council rule / statute is refused',
    'unoccupied entry without the notice left is refused (s328(5))',
    'an oral direction cannot be the one left at an unoccupied place',
    'a reader outside the custodian org cannot record particulars',
  ]) {
    assert.ok(oracle.includes(label), `oracle must carry check: ${label}`);
  }
});
