const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const conductor = fs.readFileSync(path.join(root, 'supabase/functions/onspace-ai-chat/index.ts'), 'utf8');
const caddie = fs.readFileSync(path.join(root, 'supabase/functions/onspace-ai-chat/caddie.ts'), 'utf8');
const email = fs.readFileSync(path.join(root, 'supabase/functions/bob-email-view/index.ts'), 'utf8');
const ptt = fs.readFileSync(path.join(root, 'supabase/functions/bob-ptt-view/index.ts'), 'utf8');
const vercel = fs.readFileSync(path.join(root, 'supabase/functions/bob-vercel-view/index.ts'), 'utf8');
const gitea = fs.readFileSync(path.join(root, 'supabase/functions/bob-gitea-maintainer/index.ts'), 'utf8');
const auth = fs.readFileSync(path.join(root, 'supabase/functions/_shared/platformDiagnosticAuth.ts'), 'utf8');

test('platform diagnostics use the established admin diagnostic role set', () => {
  assert.match(caddie, /inspect_platform_services:\s*\{/);
  assert.match(caddie, /governance:\s*'read-only; admiral\/captain\/commander; audited; redacted platform diagnostics; no repository writes'/);
  assert.match(caddie, /inspect_platform_services:\s*'onspace-ai-chat'/);
  assert.match(conductor, /caps\.tier !== 'admiral' && caps\.tier !== 'captain' && caps\.tier !== 'commander'/);
  assert.match(conductor, /case 'inspect_platform_services':\s*return execInspectPlatformServices/);
  assert.doesNotMatch(conductor, /inspect_platform_services[\s\S]{0,8000}method:\s*'POST'/);
});

test('Conductor has explicit bounded read routes for every platform viewer', () => {
  for (const functionName of [
    'bob-email-view',
    'bob-ptt-view',
    'bob-vercel-view',
    'bob-gitea-maintainer'
  ]) {
    assert.match(conductor, new RegExp(`/functions/v1/${functionName}`));
  }
  assert.match(conductor, /vercel_environment_variable_names requires project_id/);
  assert.match(conductor, /gitea_file requires path/);
  assert.match(conductor, /method:\s*'GET'/);
});

test('PTT diagnostics remain inspectable when the optional relay is unavailable', () => {
  assert.doesNotMatch(ptt, /if \(!BASE\) throw new Error/);
  assert.doesNotMatch(ptt, /if \(!TOKEN\) throw new Error/);
  assert.match(ptt, /code:\s*'NO_RELAY'/);
  assert.match(ptt, /relayConfigured:\s*Boolean\(BASE && TOKEN\)/);
});

test('platform viewers verify the caller and do not trust decoded claims', () => {
  assert.match(auth, /caller\.auth\.getUser\(\)/);
  assert.match(auth, /OWNER_EMAILS/);
  assert.match(auth, /CAN_SQL\.has\(role\)/);
  assert.match(auth, /resolveEffectiveRole/);
  for (const source of [email, ptt, vercel, gitea]) {
    assert.match(source, /authorizePlatformDiagnostic\(req, true\)/);
  }
  assert.match(gitea, /method !== 'GET' && caller\.role !== 'bob'/);
  assert.match(gitea, /WRITE_REQUIRES_GOVERNED_BOB_IDENTITY/);
});

test('diagnostic outputs redact sensitive values and require audit writes', () => {
  assert.doesNotMatch(email, /subject:\s*m\.subject/);
  assert.doesNotMatch(email, /to:\s*m\.to/);
  assert.match(email, /redactValue\(y\.body\)/);
  assert.match(ptt, /REDACTED_EMAIL/);
  assert.match(ptt, /REDACTED_IP/);
  assert.match(vercel, /data: redactValue\(x\.body\?\.projects/);
  for (const source of [email, ptt, vercel, gitea]) {
    assert.match(source, /Audit write failed/);
    assert.match(source, /actor_user_id:/);
    assert.match(source, /target_table:\s*'edge_function'/);
    assert.match(source, /metadata:\s*\{/);
    assert.doesNotMatch(source, /entity_type:\s*'integration'/);
    assert.doesNotMatch(source, /change_summary:/);
    assert.doesNotMatch(source, /\.catch\(\(\)=>\{\}\)/);
  }
});
