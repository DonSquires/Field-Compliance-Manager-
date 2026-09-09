const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('web deployment enables transport and browser security headers', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'apps/web/vercel.json'), 'utf8'));
  const headers = config.headers?.[0]?.headers ?? [];
  const values = new Map(headers.map((header) => [header.key, header.value]));
  assert.match(values.get('Strict-Transport-Security') || '', /max-age=31536000/);
  assert.equal(values.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(values.get('X-Frame-Options'), 'DENY');
  assert.equal(values.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
});