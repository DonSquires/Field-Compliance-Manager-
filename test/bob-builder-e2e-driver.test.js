const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../scripts/bob-builder-e2e.mjs'), 'utf8');
const room = source.match(/async function room\(body\) \{([\s\S]*?)\n\}/)?.[1];
const session = source.match(/async function session\([^\n]*\) \{([\s\S]*?)\n\}/)?.[1];

test('room retries the same control-room request only once after HTTP 401 with a fresh session', () => {
  assert.ok(room);
  assert.ok(session);
  assert.match(room, /const payload = JSON\.stringify\(body\)/);
  assert.match(room, /body: payload/);
  assert.match(room, /let r = await sendRequest\(s\)/);
  assert.match(room, /if \(r\.status === 401\) r = await sendRequest\(await session\(\{ fresh: true \}\)\)/);
  assert.equal((room.match(/\bsendRequest\(/g) ?? []).length, 2);
  assert.match(room, /return \{ status: r\.status, \.\.\.parsed \}/);
  assert.match(session, /if \(!fresh\)\s*\{\s*try \{\s*const cached = JSON\.parse\(fs\.readFileSync\(CACHE, 'utf8'\)\)/);
  assert.match(session, /grant_type=password/);
});

test('the session cache path is unchanged', () => {
  assert.match(source, /const CACHE = '\/tmp\/\.fcm-builder-e2e-session\.json';/);
});

test('recovery does not log credentials, tokens, headers, or session objects', () => {
  assert.doesNotMatch(source.slice(source.indexOf('async function session('), source.indexOf('function brief(')), /\bconsole\.\w+\s*\(/);
  const logStatements = source.split('\n').filter((line) => /\bconsole\.(?:log|error|warn|debug|info)\s*\(/.test(line)).join('\n');
  assert.doesNotMatch(logStatements, /\b(?:PAT|EMAIL|PASSWORD|Authorization|auth|session|cached|key|headers)\b|\.access_token\b/);
  assert.doesNotMatch(logStatements, /\bconsole\.\w+\s*\(\s*(?:s|data)\s*[,)]/);
});
