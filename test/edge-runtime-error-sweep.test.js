const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('pg_cron edge targets skip gateway JWT checks because Vault holds a non-JWT key', () => {
  const config = read('supabase/config.toml');
  for (const slug of ['welfare-escalation-tick', 'notify-credential-expiry', 'bob-refresh-canonical-ta-names']) {
    assert.match(config, new RegExp(`\\[functions\\.${slug}\\]\\s*\\nverify_jwt = false`), slug);
    const source = read(`supabase/functions/${slug}/index.ts`);
    assert.match(source, /if \(!isServiceRole && !isCron\) \{/, `${slug} must fail closed in code`);
  }
});

test('roster rollback proposal passes its idempotency key explicitly', () => {
  const source = read('supabase/functions/bob-propose-roster-rollback/index.ts');
  assert.match(source, /idempotency_key: idempotencyKey,/);
  assert.doesNotMatch(source, /triggered_by: caller\.id, idempotency_key,/);
});

test('task lifecycle treats staged proposals as completed steps', () => {
  for (const file of ['supabase/functions/_shared/task-lifecycle.ts', 'supabase/functions/_shared/task-lifecycle.js']) {
    assert.match(read(file), /outcome === 'proposed'/, file);
  }
  const chat = read('supabase/functions/onspace-ai-chat/index.ts');
  assert.match(chat, /else if \(taskLedger && claimResult\.step\)/);
  assert.match(chat, /else if \(taskLedger && finishResult\.updatedStep\)/);
});
