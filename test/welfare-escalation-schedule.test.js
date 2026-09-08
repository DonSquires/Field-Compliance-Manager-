const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const schedule = fs.readFileSync(path.join(root, 'supabase/migrations/20260908005000_schedule_welfare_escalation_tick.sql'), 'utf8');
const activation = fs.readFileSync(path.join(root, 'supabase/migrations/20260908005100_activate_welfare_escalation_tick.sql'), 'utf8');

test('welfare escalation is scheduled through Vault-backed backend-only cron', () => {
  assert.match(schedule, /ops\.enqueue_welfare_escalation_tick/);
  assert.match(schedule, /vault\.decrypted_secrets/);
  assert.match(schedule, /x-cron-secret/);
  assert.match(schedule, /functions\/v1\/welfare-escalation-tick/);
  assert.match(schedule, /welfare-escalation-tick-every-minute/);
  assert.match(schedule, /'\* \* \* \* \*'/);
  assert.match(activation, /cron\.alter_job\(v_job_id, active => true\)/);
  assert.doesNotMatch(schedule, /apps\/web/);
});
