const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260927090000_builder_cancel_job.sql'), 'utf8');
const controlRoom = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/bob-builder-control-room/index.ts'), 'utf8');
const driver = fs.readFileSync(path.resolve(__dirname, '../scripts/bob-builder-e2e.mjs'), 'utf8');

test('builder_cancel_job is an authorized, atomic human decision with an audit event', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_cancel_job\(_job_id uuid, _reason text\)/);
  assert.match(migration, /RETURNS public\.builder_jobs[\s\S]*?SECURITY DEFINER\s+SET search_path TO 'public'/);
  assert.match(migration, /auth\.role\(\) IS DISTINCT FROM 'authenticated' OR _uid IS NULL/);
  assert.match(migration, /btrim\(_reason\)/);
  assert.match(migration, /_trimmed_reason IS NULL OR _trimmed_reason = '' OR char_length\(_trimmed_reason\) > 2000/);
  assert.match(migration, /FROM public\.builder_jobs\s+WHERE id = _job_id\s+FOR UPDATE/);
  assert.match(migration, /IF NOT FOUND THEN\s+RAISE EXCEPTION 'Builder job not found'/);
  assert.match(migration, /_job\.status IN \('deployed', 'failed', 'cancelled'\) THEN\s+RAISE EXCEPTION 'Builder job is already finished'/);
  assert.match(migration, /public\.can_approve_action\(_uid, _job\.organization_id\)/);
  assert.match(migration, /SET status = 'cancelled',[\s\S]*?last_error = 'Cancelled: ' \|\| _trimmed_reason,[\s\S]*?autopilot_state = CASE WHEN autopilot_requested_by IS NOT NULL THEN 'done' ELSE autopilot_state END,[\s\S]*?updated_at = now\(\)/);
  assert.match(migration, /INSERT INTO public\.builder_audit_events \([\s\S]*?organization_id, job_id, event_type, actor_user_id, actor_type,[\s\S]*?previous_value, new_value, change_summary[\s\S]*?\) VALUES \([\s\S]*?_job\.organization_id, _job\.id, 'job_cancelled', _uid, 'human',[\s\S]*?jsonb_build_object\('status', _job\.status\),[\s\S]*?jsonb_build_object\('status', 'cancelled', 'reason', _trimmed_reason\)/);
  assert.match(migration, /RETURN _updated_job;/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.builder_cancel_job\(uuid, text\) FROM PUBLIC, anon;/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.builder_cancel_job\(uuid, text\) TO authenticated;/);
  assert.doesNotMatch(migration, /\bALTER TABLE\b/i);
});

test('control-room cancel action reuses job scope and invokes the caller-JWT RPC', () => {
  assert.match(controlRoom, /const jobId = typeof body\.job_id === 'string' \? body\.job_id : ''/);
  assert.match(controlRoom, /if \(!job \|\| !canAccessOrganization\(job\.organization_id\)\) return json\(\{ error: 'Builder job is unavailable' \}, 404\)/);
  const cancel = controlRoom.match(/if \(action === 'cancel'\) \{([\s\S]*?)\r?\n  \}\r?\n  if \(action === 'read_artifact'\)/)?.[1];
  assert.ok(cancel, 'job-scoped cancel branch exists');
  assert.match(cancel, /typeof body\.reason === 'string' \? body\.reason\.trim\(\) : ''/);
  assert.match(cancel, /if \(!reason\) return json\(\{ error: .*? \}, 400\)/);
  assert.match(cancel, /callerClient\.rpc\('builder_cancel_job', \{ _job_id: jobId, _reason: reason \}\)/);
  assert.match(cancel, /if \(error\) return json\(\{ error: error\.message \}, 409\)/);
  assert.match(cancel, /await audit\(job\.organization_id, 'cancelled', jobId\)/);
  assert.match(cancel, /return json\(\{ job: safeJob\(data as Record<string, unknown>\) \}\)/);
});

test('driver cancel command posts a reason and prints the show-style status line', () => {
  assert.match(driver, /cmd === 'cancel'/);
  assert.match(driver, /room\(\{ action: 'cancel', job_id: jobId, reason \}\)/);
  assert.match(driver, /console\.log\(out\.job \? brief\(out\)/);
  assert.match(driver, /cancel <job_id>/);
});
