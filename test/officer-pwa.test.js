const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const publicDir = join(__dirname, '../apps/web/public');
test('officer home-screen manifest uses actual square Iron Eagle PNG icons', () => {
  const manifest = JSON.parse(readFileSync(join(publicDir, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.id, '/officer');
  assert.equal(manifest.start_url, '/officer');
  assert.equal(manifest.display, 'standalone');
  for (const size of [180, 192, 512]) {
    const png = readFileSync(join(publicDir, 'assets', 'pwa', `ie-${size}.png`));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  assert.deepEqual(manifest.icons.map(icon => icon.sizes), ['192x192', '512x512']);
});
test('worker does not cache data, intercept APIs or report offline work as saved', async () => {
  let handler;
  const source = readFileSync(join(publicDir, 'officer-sw.js'), 'utf8');
  assert.doesNotMatch(source, /\bcaches\b|indexedDB|localStorage|access_token/);
  runInNewContext(source, {
    self: { location: { origin: 'https://fixture.invalid' }, addEventListener: (type, callback) => { assert.equal(type, 'fetch'); handler = callback; } },
    URL, Response, fetch: async () => { throw new Error('Synthetic offline'); },
  });
  let response;
  handler({ request: { url: 'https://fixture.invalid/rest/v1/private', mode: 'cors' }, respondWith: () => { throw new Error('Must not intercept API'); } });
  handler({ request: { url: 'https://fixture.invalid/officer', mode: 'navigate' }, respondWith: promise => { response = promise; } });
  const offline = await response;
  assert.equal(offline.status, 503);
  assert.equal(offline.headers.get('Cache-Control'), 'no-store');
  assert.match(await offline.text(), /does not confirm that any work was saved/);
});
