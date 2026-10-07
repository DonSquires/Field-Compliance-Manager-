const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const readSql = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const schedule = readSql('supabase/migrations/20260908005000_schedule_welfare_escalation_tick.sql');
const activation = readSql('supabase/migrations/20260908005100_activate_welfare_escalation_tick.sql');
const credentialSchedule = readSql('supabase/migrations/20260908005200_schedule_credential_expiry_notifications.sql');
const taSchedule = readSql('supabase/migrations/20260908005300_schedule_canonical_ta_refresh.sql');

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

test('credential expiry notifications run through a daily Vault-backed backend schedule', () => {
  assert.match(credentialSchedule, /ops\.enqueue_credential_expiry_notifications/);
  assert.match(credentialSchedule, /vault\.decrypted_secrets/);
  assert.match(credentialSchedule, /functions\/v1\/notify-credential-expiry/);
  assert.match(credentialSchedule, /x-cron-secret/);
  assert.match(credentialSchedule, /credential-expiry-notifications-daily/);
  assert.match(credentialSchedule, /'17 6 \* \* \*'/);
  assert.match(credentialSchedule, /true\n  \);/);
});

test('canonical territorial-authority names refresh weekly through a backend schedule', () => {
  assert.match(taSchedule, /ops\.enqueue_canonical_ta_refresh/);
  assert.match(taSchedule, /vault\.decrypted_secrets/);
  assert.match(taSchedule, /functions\/v1\/bob-refresh-canonical-ta-names/);
  assert.match(taSchedule, /canonical-ta-refresh-weekly/);
  assert.match(taSchedule, /'23 3 \* \* 0'/);
  assert.match(taSchedule, /true\n  \);/);
});
